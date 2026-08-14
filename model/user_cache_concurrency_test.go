package model

import (
	"sync/atomic"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestPopulateUserCachePublishesQuotaSchema(t *testing.T) {
	truncateTables(t)
	useUserCacheMiniRedis(t)

	user := User{
		Username: "quota-schema-user",
		Password: "password",
		Status:   common.UserStatusEnabled,
		Group:    "default",
		Quota:    100,
	}
	require.NoError(t, DB.Create(&user).Error)
	require.NoError(t, populateUserCache(user))

	schema, err := common.RDB.HGet(t.Context(), getUserCacheKey(user.Id), "CacheSchema").Int()
	require.NoError(t, err)
	assert.Equal(t, userCacheSchemaVersion, schema)
}

func TestDelayedUserCacheHydrationPreservesReservedQuota(t *testing.T) {
	truncateTables(t)
	resetBatchUpdateTestState(t)
	useUserCacheMiniRedis(t)

	user := User{
		Username: "delayed-quota-hydration",
		Password: "password",
		Status:   common.UserStatusEnabled,
		Group:    "default",
		Quota:    10,
	}
	require.NoError(t, DB.Create(&user).Error)
	require.NoError(t, populateUserCache(user))
	stale := user

	reserved, err := TryReserveUserQuota(user.Id, 8)
	require.NoError(t, err)
	require.True(t, reserved)
	require.NoError(t, populateUserCache(stale))

	reserved, err = TryReserveUserQuota(user.Id, 3)
	require.NoError(t, err)
	assert.False(t, reserved, "delayed hydration must not restore already reserved quota")
	cached, err := cacheGetUserBase(user.Id)
	require.NoError(t, err)
	assert.Equal(t, 2, cached.Quota)
}

func TestInvalidationRejectsDelayedEnabledHydration(t *testing.T) {
	truncateTables(t)
	useUserCacheMiniRedis(t)

	user := User{
		Username: "delayed-enabled-hydration",
		Password: "password",
		Status:   common.UserStatusEnabled,
		Group:    "default",
	}
	require.NoError(t, DB.Create(&user).Error)

	firstSnapshotRead := make(chan struct{})
	releaseDelayedHydration := make(chan struct{})
	var intercepted atomic.Bool
	const callbackName = "test:block_delayed_enabled_hydration"
	require.NoError(t, DB.Callback().Query().After("gorm:query").Register(callbackName, func(*gorm.DB) {
		if intercepted.CompareAndSwap(false, true) {
			close(firstSnapshotRead)
			<-releaseDelayedHydration
		}
	}))
	t.Cleanup(func() {
		_ = DB.Callback().Query().Remove(callbackName)
	})

	type cacheResult struct {
		user *UserBase
		err  error
	}
	delayedResult := make(chan cacheResult, 1)
	go func() {
		cached, err := GetUserCache(user.Id)
		delayedResult <- cacheResult{user: cached, err: err}
	}()
	<-firstSnapshotRead

	require.NoError(t, DB.Model(&User{}).Where("id = ?", user.Id).
		Update("status", common.UserStatusDisabled).Error)
	require.NoError(t, InvalidateUserCache(user.Id))
	close(releaseDelayedHydration)

	result := <-delayedResult
	require.NoError(t, result.err)
	require.NotNil(t, result.user)
	assert.Equal(t, common.UserStatusDisabled, result.user.Status)
	cached, err := cacheGetUserBase(user.Id)
	require.NoError(t, err)
	assert.Equal(t, common.UserStatusDisabled, cached.Status)
}

func TestStaleProfileCacheRefreshPreservesRestrictiveStatus(t *testing.T) {
	truncateTables(t)
	useUserCacheMiniRedis(t)

	user := User{
		Username: "stale-profile-cache-user",
		Password: "password",
		Status:   common.UserStatusEnabled,
		Group:    "default",
		Quota:    100,
	}
	require.NoError(t, DB.Create(&user).Error)
	require.NoError(t, populateUserCache(user))
	stale := user

	require.NoError(t, DB.Model(&User{}).Where("id = ?", user.Id).
		Update("status", common.UserStatusDisabled).Error)
	require.NoError(t, common.RedisHSetField(
		getUserCacheKey(user.Id), "Status", common.UserStatusDisabled,
	))

	stale.DisplayName = "updated-profile"
	require.NoError(t, updateUserCache(stale))

	cached, err := cacheGetUserBase(user.Id)
	require.NoError(t, err)
	assert.Equal(t, common.UserStatusDisabled, cached.Status)
	assert.Equal(t, 100, cached.Quota)
}

func TestRefreshUserGroupCacheRepairsDelayedWrite(t *testing.T) {
	truncateTables(t)
	useUserCacheMiniRedis(t)

	user := User{
		Username: "delayed-group-refresh",
		Password: "password",
		Status:   common.UserStatusEnabled,
		Group:    "default",
	}
	require.NoError(t, DB.Create(&user).Error)
	require.NoError(t, populateUserCache(user))

	firstSnapshotRead := make(chan struct{})
	releaseDelayedRefresh := make(chan struct{})
	var intercepted atomic.Bool
	const callbackName = "test:block_delayed_fork_group_refresh"
	require.NoError(t, DB.Callback().Query().After("gorm:query").Register(callbackName, func(*gorm.DB) {
		if intercepted.CompareAndSwap(false, true) {
			close(firstSnapshotRead)
			<-releaseDelayedRefresh
		}
	}))
	t.Cleanup(func() {
		_ = DB.Callback().Query().Remove(callbackName)
	})

	delayedResult := make(chan error, 1)
	go func() {
		delayedResult <- RefreshUserGroupCache(user.Id)
	}()
	<-firstSnapshotRead

	require.NoError(t, DB.Model(&User{}).Where("id = ?", user.Id).Update("group", "pro").Error)
	require.NoError(t, RefreshUserGroupCache(user.Id))

	close(releaseDelayedRefresh)
	require.NoError(t, <-delayedResult)
	cached, err := cacheGetUserBase(user.Id)
	require.NoError(t, err)
	assert.Equal(t, "pro", cached.Group)
}

func TestSubscriptionGroupCacheCompatibilityUsesDatabaseValue(t *testing.T) {
	truncateTables(t)
	useUserCacheMiniRedis(t)

	user := User{
		Username: "subscription-group-cache",
		Password: "password",
		Status:   common.UserStatusEnabled,
		Group:    "default",
	}
	require.NoError(t, DB.Create(&user).Error)
	require.NoError(t, populateUserCache(user))
	require.NoError(t, DB.Model(&User{}).Where("id = ?", user.Id).Update("group", "vip").Error)

	require.NoError(t, UpdateUserGroupCache(user.Id, "stale-default"))

	cached, err := cacheGetUserBase(user.Id)
	require.NoError(t, err)
	assert.Equal(t, "vip", cached.Group)
}
