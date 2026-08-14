package model

import (
	"context"
	"errors"
	"fmt"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"

	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
)

const userCacheSchemaVersion = 3

var errUserCacheInvalidated = errors.New("user cache invalidated during hydration")

// UserBase struct remains the same as it represents the cached data structure
type UserBase struct {
	Id          int    `json:"id"`
	Group       string `json:"group"`
	Email       string `json:"email"`
	Quota       int    `json:"quota"`
	Status      int    `json:"status"`
	Username    string `json:"username"`
	Setting     string `json:"setting"`
	CacheSchema int    `json:"-"`
	CacheEpoch  int64  `json:"-"`
}

func (user *UserBase) WriteContext(c *gin.Context) {
	common.SetContextKey(c, constant.ContextKeyUserGroup, user.Group)
	common.SetContextKey(c, constant.ContextKeyUserQuota, user.Quota)
	common.SetContextKey(c, constant.ContextKeyUserStatus, user.Status)
	common.SetContextKey(c, constant.ContextKeyUserEmail, user.Email)
	common.SetContextKey(c, constant.ContextKeyUserName, user.Username)
	common.SetContextKey(c, constant.ContextKeyUserSetting, user.GetSetting())
}

func (user *UserBase) GetSetting() dto.UserSetting {
	setting := dto.UserSetting{}
	if user.Setting != "" {
		err := common.Unmarshal([]byte(user.Setting), &setting)
		if err != nil {
			common.SysLog("failed to unmarshal setting: " + err.Error())
		}
	}
	return setting
}

// getUserCacheKey returns the key for user cache
func getUserCacheKey(userId int) string {
	return fmt.Sprintf("user:%d", userId)
}

func getUserCacheEpochKey(userId int) string {
	return fmt.Sprintf("user:%d:epoch", userId)
}

func getUserCacheEpoch(userId int) (int64, error) {
	epoch, err := common.RDB.Get(context.Background(), getUserCacheEpochKey(userId)).Int64()
	if errors.Is(err, redis.Nil) {
		return 0, nil
	}
	return epoch, err
}

// invalidateUserCache clears user cache
func invalidateUserCache(userId int) error {
	if !common.RedisEnabled {
		return nil
	}
	const script = `
	local epoch = redis.call('INCR', KEYS[2])
	redis.call('DEL', KEYS[1])
	return epoch`
	return common.RDB.Eval(
		context.Background(),
		script,
		[]string{getUserCacheKey(userId), getUserCacheEpochKey(userId)},
	).Err()
}

// InvalidateUserCache exposes cache invalidation to controller mutation paths.
func InvalidateUserCache(userId int) error {
	return invalidateUserCache(userId)
}

func populateUserCache(user User) error {
	if !common.RedisEnabled {
		return nil
	}
	epoch, err := getUserCacheEpoch(user.Id)
	if err != nil {
		return err
	}
	var authoritative User
	if err := DB.Select("id", "status", commonGroupCol).Where("id = ?", user.Id).First(&authoritative).Error; err != nil {
		return err
	}
	user.Status = authoritative.Status
	user.Group = authoritative.Group
	return populateUserCacheAtEpoch(user, epoch)
}

func populateUserCacheAtEpoch(user User, epoch int64) error {
	cache := user.ToBaseUser()
	cache.CacheSchema = userCacheSchemaVersion
	cache.CacheEpoch = epoch
	ttl := common.RedisKeyCacheSeconds()
	if ttl <= 0 {
		ttl = 60
	}
	const script = `
	local currentEpoch = tonumber(redis.call('GET', KEYS[2]) or '0')
	if currentEpoch ~= tonumber(ARGV[1]) then
	  return 0
	end
	redis.call('HSET', KEYS[1],
	  'Id', ARGV[2], 'Group', ARGV[3], 'Email', ARGV[4],
	  'Status', ARGV[5], 'Username', ARGV[6], 'Setting', ARGV[7],
	  'CacheSchema', ARGV[8], 'CacheEpoch', ARGV[1])
	if redis.call('HEXISTS', KEYS[1], 'Quota') == 0 then
	  redis.call('HSET', KEYS[1], 'Quota', ARGV[9])
	end
	redis.call('EXPIRE', KEYS[1], ARGV[10])
	return 1`
	result, err := common.RDB.Eval(
		context.Background(),
		script,
		[]string{getUserCacheKey(user.Id), getUserCacheEpochKey(user.Id)},
		epoch,
		cache.Id,
		cache.Group,
		cache.Email,
		cache.Status,
		cache.Username,
		cache.Setting,
		cache.CacheSchema,
		cache.Quota,
		ttl,
	).Int()
	if err != nil {
		return err
	}
	if result == 0 {
		return errUserCacheInvalidated
	}
	return nil
}

// updateUserCache refreshes non-quota user cache fields.
// Quota is maintained by atomic quota delta paths and must not be overwritten
// by stale user snapshots from profile/settings updates.
func updateUserCache(user User) error {
	if !common.RedisEnabled {
		return nil
	}
	if err := RefreshUserGroupCache(user.Id); err != nil {
		return err
	}
	if err := updateUserEmailCache(user.Id, user.Email); err != nil {
		return err
	}
	if err := updateUserNameCache(user.Id, user.Username); err != nil {
		return err
	}
	return updateUserSettingCache(user.Id, user.Setting)
}

// GetUserCache gets complete user cache from hash
func GetUserCache(userId int) (*UserBase, error) {
	if common.RedisEnabled {
		for range 3 {
			if userCache, err := cacheGetUserBase(userId); err == nil {
				return userCache, nil
			}
			epoch, err := getUserCacheEpoch(userId)
			if err != nil {
				break
			}
			user, err := GetUserById(userId, false)
			if err != nil {
				return nil, err
			}
			if err := populateUserCacheAtEpoch(*user, epoch); err != nil {
				if errors.Is(err, errUserCacheInvalidated) {
					continue
				}
				common.SysLog("failed to synchronously populate user cache: " + err.Error())
				return userBaseFromUser(*user, epoch), nil
			}
			if userCache, err := cacheGetUserBase(userId); err == nil {
				return userCache, nil
			}
		}
		return nil, errUserCacheInvalidated
	}

	user, err := GetUserById(userId, false)
	if err != nil {
		return nil, err
	}
	return userBaseFromUser(*user, 0), nil
}

func userBaseFromUser(user User, epoch int64) *UserBase {
	return &UserBase{
		Id:          user.Id,
		Group:       user.Group,
		Quota:       user.Quota,
		Status:      user.Status,
		Username:    user.Username,
		Setting:     user.Setting,
		Email:       user.Email,
		CacheSchema: userCacheSchemaVersion,
		CacheEpoch:  epoch,
	}
}

func cacheGetUserBase(userId int) (*UserBase, error) {
	if !common.RedisEnabled {
		return nil, fmt.Errorf("redis is not enabled")
	}
	var userCache UserBase
	// Try getting from Redis first
	err := common.RedisHGetObj(getUserCacheKey(userId), &userCache)
	if err != nil {
		return nil, err
	}
	if userCache.Id != userId || userCache.CacheSchema != userCacheSchemaVersion {
		return nil, fmt.Errorf("user cache schema is stale")
	}
	epoch, err := getUserCacheEpoch(userId)
	if err != nil {
		return nil, err
	}
	if userCache.CacheEpoch != epoch {
		return nil, errUserCacheInvalidated
	}
	return &userCache, nil
}

// Add atomic quota operations using hash fields.
// 通过守卫式 Lua 脚本执行：哈希不存在时直接跳过（下次读取会从数据库水合），
// 不会像裸 HINCRBY 那样创建只含 Quota 字段的残缺哈希。
func cacheIncrUserQuota(userId int, delta int64) error {
	if !common.RedisEnabled {
		return nil
	}
	_, err := cacheApplyUserQuotaDelta(userId, delta)
	return err
}

func cacheDecrUserQuota(userId int, delta int64) error {
	return cacheIncrUserQuota(userId, -delta)
}

// syncCreditUserQuotaCache 在授信事务（充值/兑换等）提交后同步把增量补进缓存
// 余额。预扣以缓存值为准（存在期间），授信不能绕过它，否则新到账的额度在
// 缓存过期前不可用；缓存未命中无需处理，下次读取会从已提交的数据库余额水合。
func syncCreditUserQuotaCache(userId int, quota int, operation string) {
	if quota <= 0 {
		return
	}
	if err := cacheIncrUserQuota(userId, int64(quota)); err != nil {
		common.SysLog(fmt.Sprintf("failed to sync %s credit to user quota cache: %s", operation, err.Error()))
	}
}

// Helper functions to get individual fields if needed
func getUserGroupCache(userId int) (string, error) {
	cache, err := GetUserCache(userId)
	if err != nil {
		return "", err
	}
	return cache.Group, nil
}

func getUserQuotaCache(userId int) (int, error) {
	cache, err := GetUserCache(userId)
	if err != nil {
		return 0, err
	}
	return cache.Quota, nil
}

func getUserNameCache(userId int) (string, error) {
	cache, err := GetUserCache(userId)
	if err != nil {
		return "", err
	}
	return cache.Username, nil
}

func getUserSettingCache(userId int) (dto.UserSetting, error) {
	cache, err := GetUserCache(userId)
	if err != nil {
		return dto.UserSetting{}, err
	}
	return cache.GetSetting(), nil
}

// RefreshUserGroupCache writes the database-authoritative group into an
// existing user hash. Re-reading after each write repairs a delayed stale
// refresh without requiring the upstream auth-version cache architecture.
func RefreshUserGroupCache(userId int) error {
	if !common.RedisEnabled {
		return nil
	}
	if userId <= 0 {
		return fmt.Errorf("invalid user id")
	}

	var authoritative User
	if err := DB.Select("id", commonGroupCol).Where("id = ?", userId).First(&authoritative).Error; err != nil {
		return err
	}
	for range 3 {
		updated, err := updateUserCacheFieldIfPresent(userId, "Group", authoritative.Group)
		if err != nil || !updated {
			return err
		}

		var verified User
		if err := DB.Select("id", commonGroupCol).Where("id = ?", userId).First(&verified).Error; err != nil {
			return err
		}
		if verified.Group == authoritative.Group {
			return nil
		}
		authoritative = verified
	}

	if _, err := updateUserCacheFieldIfPresent(userId, "Group", authoritative.Group); err != nil {
		return err
	}
	return fmt.Errorf("user group changed repeatedly during cache refresh")
}

func updateUserGroupCache(userId int, _ string) error {
	return RefreshUserGroupCache(userId)
}

func UpdateUserGroupCache(userId int, _ string) error {
	return RefreshUserGroupCache(userId)
}

func updateUserEmailCache(userId int, email string) error {
	if !common.RedisEnabled {
		return nil
	}
	_, err := updateUserCacheFieldIfPresent(userId, "Email", email)
	return err
}

func updateUserNameCache(userId int, username string) error {
	if !common.RedisEnabled {
		return nil
	}
	_, err := updateUserCacheFieldIfPresent(userId, "Username", username)
	return err
}

func updateUserSettingCache(userId int, setting string) error {
	if !common.RedisEnabled {
		return nil
	}
	_, err := updateUserCacheFieldIfPresent(userId, "Setting", setting)
	return err
}

const updateUserCacheFieldIfPresentScript = `
if tonumber(redis.call('HGET', KEYS[1], 'Id') or '0') ~= tonumber(ARGV[1])
  or tonumber(redis.call('HGET', KEYS[1], 'CacheSchema') or '0') ~= tonumber(ARGV[2]) then
  return 0
end
redis.call('HSET', KEYS[1], ARGV[3], ARGV[4])
return 1`

// updateUserCacheFieldIfPresent never creates a partial hash. A missing or
// stale hash is repopulated from the database by the next cache read.
func updateUserCacheFieldIfPresent(userId int, field string, value interface{}) (bool, error) {
	result, err := common.RDB.Eval(
		context.Background(),
		updateUserCacheFieldIfPresentScript,
		[]string{getUserCacheKey(userId)},
		userId,
		userCacheSchemaVersion,
		field,
		value,
	).Int()
	return result == 1, err
}

// GetUserLanguage returns the user's language preference from cache
// Uses the existing GetUserCache mechanism for efficiency
func GetUserLanguage(userId int) string {
	userCache, err := GetUserCache(userId)
	if err != nil {
		return ""
	}
	return userCache.GetSetting().Language
}
