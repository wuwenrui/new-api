package model

import (
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	_ "github.com/QuantumNous/new-api/setting/billing_setting"
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupOptionSyncTestDB(t *testing.T) {
	t.Helper()
	originalDB := DB
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "option-sync.db")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&Option{}))
	DB = db

	common.OptionMapRWMutex.Lock()
	originalOptionMap := common.OptionMap
	common.OptionMap = make(map[string]string)
	common.OptionMapRWMutex.Unlock()
	originalGroupRatio := ratio_setting.GroupRatio2JSONString()
	originalRedisEnabled := common.RedisEnabled
	common.RedisEnabled = false

	t.Cleanup(func() {
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(originalGroupRatio))
		common.OptionMapRWMutex.Lock()
		common.OptionMap = originalOptionMap
		common.OptionMapRWMutex.Unlock()
		common.RedisEnabled = originalRedisEnabled
		DB = originalDB
	})
}

func TestUpdateOptionPersistsAndPublishesGroupRatio(t *testing.T) {
	setupOptionSyncTestDB(t)

	require.NoError(t, UpdateOption("GroupRatio", `{"review-group":2.5}`))

	assert.True(t, ratio_setting.ContainsGroupRatio("review-group"))
	assert.Equal(t, 2.5, ratio_setting.GetGroupRatio("review-group"))
	var option Option
	require.NoError(t, DB.First(&option, "key = ?", "GroupRatio").Error)
	assert.JSONEq(t, `{"review-group":2.5}`, option.Value)
}

func TestUpdateOptionsAtomicallyPreservesConcurrentModelAdditions(t *testing.T) {
	setupOptionSyncTestDB(t)
	require.NoError(t, UpdateOption("GroupRatio", `{}`))

	update := func(group string, ratio float64) error {
		_, err := UpdateOptionsAtomically([]string{"GroupRatio"}, func(current map[string]string) (map[string]string, error) {
			ratios := make(map[string]float64)
			if err := common.UnmarshalJsonStr(current["GroupRatio"], &ratios); err != nil {
				return nil, err
			}
			ratios[group] = ratio
			data, err := common.Marshal(ratios)
			if err != nil {
				return nil, err
			}
			return map[string]string{"GroupRatio": string(data)}, nil
		})
		return err
	}

	start := make(chan struct{})
	done := make(chan error, 2)
	for group, ratio := range map[string]float64{"first-group": 1.5, "second-group": 2.5} {
		go func() {
			<-start
			done <- update(group, ratio)
		}()
	}
	close(start)
	require.NoError(t, <-done)
	require.NoError(t, <-done)

	var option Option
	require.NoError(t, DB.First(&option, "key = ?", "GroupRatio").Error)
	var ratios map[string]float64
	require.NoError(t, common.UnmarshalJsonStr(option.Value, &ratios))
	assert.Equal(t, 1.5, ratios["first-group"])
	assert.Equal(t, 2.5, ratios["second-group"])
}

func TestBillingConfigRefreshDoesNotTakePricingCacheLockInsideSnapshotWrite(t *testing.T) {
	previousMaxProcs := runtime.GOMAXPROCS(1)
	t.Cleanup(func() { runtime.GOMAXPROCS(previousMaxProcs) })
	common.OptionMapRWMutex.Lock()
	originalOptionMap := common.OptionMap
	common.OptionMap = make(map[string]string)
	common.OptionMapRWMutex.Unlock()
	savedConfig := map[string]string{}
	require.NoError(t, config.GlobalConfig.SaveToDB(func(key, value string) error {
		savedConfig[key] = value
		return nil
	}))
	t.Cleanup(func() {
		common.OptionMapRWMutex.Lock()
		common.OptionMap = originalOptionMap
		common.OptionMapRWMutex.Unlock()
		require.NoError(t, config.GlobalConfig.LoadFromDB(savedConfig))
	})

	updatePricingLock.Lock()
	done := make(chan error, 1)
	go func() {
		done <- ratio_setting.WritePricingSnapshot(func() error {
			return updateOptionMap("billing_setting.billing_mode", `{}`)
		})
	}()
	runtime.Gosched()

	select {
	case err := <-done:
		updatePricingLock.Unlock()
		require.NoError(t, err)
	default:
		updatePricingLock.Unlock()
		<-done
		t.Fatal("billing config refresh waited for the pricing cache lock while holding the snapshot writer")
	}
}

func TestPricingUpdateNotificationInvalidatesPublicPricingCache(t *testing.T) {
	updatePricingLock.Lock()
	originalPricingMap := pricingMap
	originalVendorsList := vendorsList
	originalLastGetPricingTime := lastGetPricingTime
	pricingMap = []Pricing{{ModelName: "stale-model"}}
	vendorsList = []PricingVendor{{Name: "stale-vendor"}}
	lastGetPricingTime = time.Now()
	updatePricingLock.Unlock()
	t.Cleanup(func() {
		updatePricingLock.Lock()
		pricingMap = originalPricingMap
		vendorsList = originalVendorsList
		lastGetPricingTime = originalLastGetPricingTime
		updatePricingLock.Unlock()
	})

	originalRedisEnabled := common.RedisEnabled
	common.RedisEnabled = false
	t.Cleanup(func() { common.RedisEnabled = originalRedisEnabled })

	notifyPricingOptionUpdate()

	updatePricingLock.Lock()
	defer updatePricingLock.Unlock()
	assert.Nil(t, pricingMap)
	assert.Nil(t, vendorsList)
	assert.True(t, lastGetPricingTime.IsZero())
}
