package model

import (
	"errors"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/billing_setting"
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

func TestUpdateOptionsBulkPublishesSingleRuntimePricingGeneration(t *testing.T) {
	setupOptionSyncTestDB(t)
	preserveRuntimePricingState(t)
	before := ratio_setting.GetModelPricingSnapshot("runtime-model")

	require.NoError(t, UpdateOptionsBulk(map[string]string{
		"ModelRatio":                   `{"runtime-model":3}`,
		"CompletionRatio":              `{"runtime-model":4}`,
		"CacheRatio":                   `{"runtime-model":0.2}`,
		"CreateCacheRatio":             `{"runtime-model":1.5}`,
		"ModelPrice":                   `{"runtime-model":0.25}`,
		"billing_setting.billing_mode": `{"runtime-model":"tiered_expr"}`,
		"billing_setting.billing_expr": `{"runtime-model":"tier(\"long\", p * 3)"}`,
	}))

	after := ratio_setting.GetModelPricingSnapshot("runtime-model")
	assert.Equal(t, before.Generation+1, after.Generation)
	assert.Equal(t, 3.0, after.ModelRatio)
	assert.Equal(t, 4.0, after.CompletionRatio)
	assert.Equal(t, 0.2, after.CacheRatio)
	assert.Equal(t, 1.5, after.CreateCacheRatio)
	assert.Equal(t, 0.25, after.ModelPrice)
	assert.Equal(t, billing_setting.BillingModeTieredExpr, after.BillingMode)
	assert.Equal(t, `tier("long", p * 3)`, after.BillingExpr)
}

func TestUpdateOptionPublishesBillingConfigurationGeneration(t *testing.T) {
	setupOptionSyncTestDB(t)
	preserveRuntimePricingState(t)
	before := ratio_setting.GetModelPricingSnapshot("single-option-model")

	require.NoError(t, UpdateOption(
		"billing_setting.billing_expr",
		`{"single-option-model":"tier(\"single\", p)"}`,
	))

	after := ratio_setting.GetModelPricingSnapshot("single-option-model")
	assert.Equal(t, before.Generation+1, after.Generation)
	assert.True(t, after.BillingExprFound)
	assert.Equal(t, `tier("single", p)`, after.BillingExpr)
	var persisted Option
	require.NoError(t, DB.First(&persisted, "key = ?", "billing_setting.billing_expr").Error)
	assert.JSONEq(t, `{"single-option-model":"tier(\"single\", p)"}`, persisted.Value)
}

func TestLoadOptionsPublishesDatabasePricingAsOneGeneration(t *testing.T) {
	setupOptionSyncTestDB(t)
	preserveRuntimePricingState(t)
	require.NoError(t, DB.Create([]Option{
		{Key: "ModelRatio", Value: `{"database-generation-model":8}`},
		{Key: "billing_setting.billing_mode", Value: `{"database-generation-model":"tiered_expr"}`},
		{Key: "billing_setting.billing_expr", Value: `{"database-generation-model":"tier(\"db\", p * 8)"}`},
	}).Error)
	before := ratio_setting.GetModelPricingSnapshot("database-generation-model")

	loadOptionsFromDatabase()

	after := ratio_setting.GetModelPricingSnapshot("database-generation-model")
	assert.Equal(t, before.Generation+1, after.Generation)
	assert.Equal(t, 8.0, after.ModelRatio)
	assert.Equal(t, billing_setting.BillingModeTieredExpr, after.BillingMode)
	assert.Equal(t, `tier("db", p * 8)`, after.BillingExpr)
}

func TestRuntimePricingReadersNeverObserveMixedGenerations(t *testing.T) {
	setupOptionSyncTestDB(t)
	preserveRuntimePricingState(t)
	require.NoError(t, UpdateOptionsBulk(runtimePricingGeneration(false)))

	start := make(chan struct{})
	done := make(chan struct{})
	writerDone := make(chan error, 1)
	readerErr := make(chan error, 4)
	var readers sync.WaitGroup
	for range 4 {
		readers.Add(1)
		go func() {
			defer readers.Done()
			<-start
			for {
				select {
				case <-done:
					return
				default:
					if !validRuntimePricingGeneration(ratio_setting.GetModelPricingSnapshot("runtime-model")) {
						readerErr <- errors.New("observed mixed runtime pricing generation")
						return
					}
				}
			}
		}()
	}
	go func() {
		<-start
		for i := range 40 {
			if err := UpdateOptionsBulk(runtimePricingGeneration(i%2 == 0)); err != nil {
				writerDone <- err
				return
			}
		}
		writerDone <- nil
	}()
	close(start)
	require.NoError(t, <-writerDone)
	close(done)
	readers.Wait()
	select {
	case err := <-readerErr:
		require.NoError(t, err)
	default:
	}
}

func runtimePricingGeneration(tiered bool) map[string]string {
	if !tiered {
		return map[string]string{
			"ModelRatio": `{"runtime-model":1}`, "CompletionRatio": `{"runtime-model":2}`,
			"CacheRatio": `{"runtime-model":0.1}`, "CreateCacheRatio": `{"runtime-model":1}`,
			"ModelPrice": `{}`, "billing_setting.billing_mode": `{}`, "billing_setting.billing_expr": `{}`,
		}
	}
	return map[string]string{
		"ModelRatio": `{"runtime-model":3}`, "CompletionRatio": `{"runtime-model":4}`,
		"CacheRatio": `{"runtime-model":0.2}`, "CreateCacheRatio": `{"runtime-model":1.5}`,
		"ModelPrice": `{"runtime-model":0.25}`, "billing_setting.billing_mode": `{"runtime-model":"tiered_expr"}`,
		"billing_setting.billing_expr": `{"runtime-model":"tier(\"long\", p * 3)"}`,
	}
}

func validRuntimePricingGeneration(snapshot ratio_setting.ModelPricingSnapshot) bool {
	ratioGeneration := snapshot.ModelRatio == 1 && snapshot.CompletionRatio == 2 &&
		snapshot.CacheRatio == 0.1 && snapshot.CreateCacheRatio == 1 &&
		!snapshot.UsesFixedPrice && snapshot.BillingMode == billing_setting.BillingModeRatio &&
		!snapshot.BillingExprFound
	tieredGeneration := snapshot.ModelRatio == 3 && snapshot.CompletionRatio == 4 &&
		snapshot.CacheRatio == 0.2 && snapshot.CreateCacheRatio == 1.5 &&
		snapshot.UsesFixedPrice && snapshot.ModelPrice == 0.25 &&
		snapshot.BillingMode == billing_setting.BillingModeTieredExpr && snapshot.BillingExprFound &&
		snapshot.BillingExpr == `tier("long", p * 3)`
	return ratioGeneration || tieredGeneration
}

func preserveRuntimePricingState(t *testing.T) {
	t.Helper()
	originalConfig := map[string]string{}
	require.NoError(t, config.GlobalConfig.SaveToDB(func(key, value string) error {
		originalConfig[key] = value
		return nil
	}))
	originalValues := map[string]string{
		"ModelRatio":       ratio_setting.ModelRatio2JSONString(),
		"CompletionRatio":  ratio_setting.CompletionRatio2JSONString(),
		"CacheRatio":       ratio_setting.CacheRatio2JSONString(),
		"CreateCacheRatio": ratio_setting.CreateCacheRatio2JSONString(),
		"ModelPrice":       ratio_setting.ModelPrice2JSONString(),
	}
	t.Cleanup(func() {
		require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(originalValues["ModelRatio"]))
		require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(originalValues["CompletionRatio"]))
		require.NoError(t, ratio_setting.UpdateCacheRatioByJSONString(originalValues["CacheRatio"]))
		require.NoError(t, ratio_setting.UpdateCreateCacheRatioByJSONString(originalValues["CreateCacheRatio"]))
		require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(originalValues["ModelPrice"]))
		require.NoError(t, config.GlobalConfig.LoadFromDB(originalConfig))
	})
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
