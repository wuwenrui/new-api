package controller

import (
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/setting/billing_setting"
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupPricingOptionTestDB(t *testing.T) {
	t.Helper()

	originalDB := model.DB
	originalLogDB := model.LOG_DB
	originalRedisEnabled := common.RedisEnabled
	originalModelRatio := ratio_setting.ModelRatio2JSONString()
	common.OptionMapRWMutex.Lock()
	originalOptionMap := common.OptionMap
	common.OptionMap = make(map[string]string)
	common.OptionMapRWMutex.Unlock()
	originalCompletionRatio := ratio_setting.CompletionRatio2JSONString()
	originalCacheRatio := ratio_setting.CacheRatio2JSONString()
	originalCreateCacheRatio := ratio_setting.CreateCacheRatio2JSONString()
	originalModelPrice := ratio_setting.ModelPrice2JSONString()
	originalBillingModes, err := common.Marshal(billing_setting.GetBillingModeCopy())
	require.NoError(t, err)
	originalBillingExprs, err := common.Marshal(billing_setting.GetBillingExprCopy())
	require.NoError(t, err)

	db, err := gorm.Open(
		sqlite.Open(filepath.Join(t.TempDir(), "pricing-options.db")),
		&gorm.Config{},
	)
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.Option{}, &model.User{}, &model.Log{}, &model.Channel{}))
	model.DB = db
	model.LOG_DB = db
	common.RedisEnabled = false
	require.NoError(t, db.Create(&model.User{Id: 1, Username: "pricing-admin"}).Error)

	t.Cleanup(func() {
		model.DB = originalDB
		model.LOG_DB = originalLogDB
		common.RedisEnabled = originalRedisEnabled
		require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(originalModelRatio))
		require.NoError(t, ratio_setting.UpdateCacheRatioByJSONString(originalCacheRatio))
		require.NoError(t, ratio_setting.UpdateCreateCacheRatioByJSONString(originalCreateCacheRatio))
		require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(originalModelPrice))
		common.OptionMapRWMutex.Lock()
		common.OptionMap = originalOptionMap
		common.OptionMapRWMutex.Unlock()
		require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(originalCompletionRatio))
		require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{
			"billing_setting.billing_mode": string(originalBillingModes),
			"billing_setting.billing_expr": string(originalBillingExprs),
		}))
	})
}

func callUpdatePricingOptions(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()

	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Set("id", 1)
	context.Request = httptest.NewRequest(
		http.MethodPut,
		"/api/option/pricing",
		strings.NewReader(body),
	)
	UpdatePricingOptions(context)
	return response
}

func failSecondPricingOptionUpdate(t *testing.T) (*int, error) {
	t.Helper()
	injectedFailure := errors.New("injected pricing option write failure")
	writeCount := new(int)
	callbackName := "test:fail_ratio_switch_mid_write"
	require.NoError(t, model.DB.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema == nil || tx.Statement.Schema.Table != "options" {
			return
		}
		*writeCount++
		if *writeCount == 2 {
			tx.AddError(injectedFailure)
		}
	}))
	t.Cleanup(func() { require.NoError(t, model.DB.Callback().Update().Remove(callbackName)) })
	return writeCount, injectedFailure
}

func seedGrok46TieredPricing(t *testing.T) {
	t.Helper()
	require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{
		"billing_setting.billing_mode": `{"grok-4.6":"tiered_expr","other-model":"tiered_expr"}`,
		"billing_setting.billing_expr": `{"grok-4.6":"len < 200000 ? tier(\"base\", p * 2 + c * 10) : tier(\"context_200000\", p * 6 + c * 30)","other-model":"tier(\"base\", p)"}`,
	}))
	require.NoError(t, model.DB.Create(&model.Channel{
		Id:     31,
		Name:   "xai-official",
		Models: "grok-4.6,grok-4.6-preview",
		Status: common.ChannelStatusEnabled,
		OtherSettings: `{
			"upstream_pricing_source":"models_dev",
			"model_prices":{"grok-4.6":{
				"input":0.5,"output":2.5,"cache_read":0.05,"cache_write":0.625,
				"source":"models_dev","provider":"xai",
				"tiers":[{"name":"context_200000","context_threshold":200000,"input":1.5,"output":7.5,"cache_read":0.15,"cache_write":1.875}]
			},"other-model":{"input":2,"output":8,"cache_read":0.2,"cache_write":2,"source":"manual"}}
		}`,
	}).Error)
	require.NoError(t, model.DB.Create([]model.Option{
		{Key: "ModelRatio", Value: `{"grok-4.6":9,"other-model":1}`},
		{Key: "CompletionRatio", Value: `{"grok-4.6":5,"other-model":2}`},
		{Key: "CacheRatio", Value: `{"grok-4.6":9,"other-model":0.2}`},
		{Key: "CreateCacheRatio", Value: `{"grok-4.6":9,"other-model":1}`},
		{Key: "ModelPrice", Value: `{"other-model":1}`},
		{Key: "billing_setting.billing_mode", Value: `{"grok-4.6":"tiered_expr","other-model":"tiered_expr"}`},
		{Key: "billing_setting.billing_expr", Value: `{"grok-4.6":"tier(\"context_200000\", p * 6 + c * 30)","other-model":"tier(\"base\", p)"}`},
	}).Error)
}

const grok46UnifiedPricingRequest = `{
	"model_name":"grok-4.6",
	"billing_mode":"ratio",
	"model_ratio":38.25,
	"completion_ratio":5,
	"cache_ratio":0.1,
	"create_cache_ratio":1.25,
	"channel_id":31,
	"purchase_price":{
		"input":1.5,
		"output":7.5,
		"cache_read":0.15,
		"cache_write":1.875,
		"source":"manual"
	}
}`

func TestUpdatePricingOptionsMergesAndPersistsRelatedMapsTogether(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(
		`{"sync-test":9,"other-model":1}`,
	))

	response := callUpdatePricingOptions(t, `{
		"model_name": "sync-test",
		"model_ratio": 2,
		"completion_ratio": 4,
		"cache_ratio": 0.1,
		"create_cache_ratio": 1
	}`)

	assert.Equal(t, http.StatusOK, response.Code)
	var payload struct {
		Success bool `json:"success"`
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &payload))
	assert.True(t, payload.Success)

	var options []model.Option
	require.NoError(t, model.DB.Find(&options).Error)
	require.Len(t, options, 5)
	values := make(map[string]map[string]float64, len(options))
	for _, option := range options {
		var value map[string]float64
		require.NoError(t, common.UnmarshalJsonStr(option.Value, &value))
		values[option.Key] = value
	}
	assert.Equal(t, 2.0, values["ModelRatio"]["sync-test"])
	assert.Equal(t, 4.0, values["CompletionRatio"]["sync-test"])
	assert.Equal(t, 0.1, values["CacheRatio"]["sync-test"])
	assert.Equal(t, 1.0, values["CreateCacheRatio"]["sync-test"])
	assert.NotContains(t, values["ModelPrice"], "sync-test")
	assert.Equal(t, 1.0, values["ModelPrice"]["other-model"])

	var logs []model.Log
	require.NoError(t, model.LOG_DB.Find(&logs).Error)
	require.Len(t, logs, 1)
	assert.Contains(t, logs[0].Other, `"action":"option.pricing.update"`)
	assert.Equal(t, "Synchronized selling price for model sync-test", logs[0].Content)
}

func TestUpdatePricingOptionsAtomicallyWritesExplicitFreeRatios(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	require.NoError(t, model.DB.Create([]model.Option{
		{Key: "ModelRatio", Value: `{"other-model":2}`},
		{Key: "CompletionRatio", Value: `{"other-model":4}`},
		{Key: "CacheRatio", Value: `{"other-model":0.1}`},
		{Key: "CreateCacheRatio", Value: `{"other-model":1.25}`},
		{Key: "ModelPrice", Value: `{"other-model":1}`},
	}).Error)

	response := callUpdatePricingOptions(t, `{
		"model_name":"ox-free",
		"billing_mode":"ratio",
		"free":true,
		"create_only":true,
		"model_ratio":0,
		"completion_ratio":0,
		"cache_ratio":0,
		"create_cache_ratio":0
	}`)

	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var payload struct {
		Success bool `json:"success"`
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &payload))
	require.True(t, payload.Success)

	var options []model.Option
	require.NoError(t, model.DB.Find(&options).Error)
	values := make(map[string]string, len(options))
	for _, option := range options {
		values[option.Key] = option.Value
	}
	for key, previous := range map[string]float64{
		"ModelRatio": 2, "CompletionRatio": 4, "CacheRatio": 0.1, "CreateCacheRatio": 1.25,
	} {
		var ratios map[string]float64
		require.NoError(t, common.UnmarshalJsonStr(values[key], &ratios))
		assert.Equal(t, 0.0, ratios["ox-free"])
		assert.Equal(t, previous, ratios["other-model"])
	}
	var fixedPrices map[string]float64
	require.NoError(t, common.UnmarshalJsonStr(values["ModelPrice"], &fixedPrices))
	assert.NotContains(t, fixedPrices, "ox-free")
	assert.Equal(t, 1.0, fixedPrices["other-model"])
}

func TestUpdatePricingOptionsCreateOnlyRejectsExistingModelInsideTransaction(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	require.NoError(t, model.DB.Create([]model.Option{
		{Key: "ModelRatio", Value: `{"ox-free":9,"other-model":2}`},
		{Key: "CompletionRatio", Value: `{"other-model":4}`},
		{Key: "CacheRatio", Value: `{"other-model":0.1}`},
		{Key: "CreateCacheRatio", Value: `{"other-model":1.25}`},
		{Key: "ModelPrice", Value: `{"other-model":1}`},
	}).Error)
	var before []model.Option
	require.NoError(t, model.DB.Order("key").Find(&before).Error)

	response := callUpdatePricingOptions(t, `{
		"model_name":"ox-free","billing_mode":"ratio","free":true,"create_only":true,
		"model_ratio":0,"completion_ratio":0,"cache_ratio":0,"create_cache_ratio":0
	}`)

	require.Equal(t, http.StatusConflict, response.Code, response.Body.String())
	var after []model.Option
	require.NoError(t, model.DB.Order("key").Find(&after).Error)
	assert.Equal(t, before, after)
}

func TestValidatePricingOptionsRequestRequiresExplicitFreeConfiguration(t *testing.T) {
	zero := 0.0
	request := PricingOptionsUpdateRequest{
		ModelName:        "ox-free",
		ModelRatio:       0,
		CompletionRatio:  &zero,
		CacheRatio:       &zero,
		CreateCacheRatio: &zero,
		BillingMode:      billing_setting.BillingModeRatio,
	}

	require.Error(t, validatePricingOptionsRequest(request))
	request.Free = true
	require.NoError(t, validatePricingOptionsRequest(request))
	request.Free = false
	request.CreateOnly = true
	require.ErrorContains(t, validatePricingOptionsRequest(request), "只允许用于显式免费模型")
	request.Free = true

	nonZero := 1.0
	request.CompletionRatio = &nonZero
	require.ErrorContains(t, validatePricingOptionsRequest(request), "倍率全部设为 0")
	request.CompletionRatio = &zero
	request.BillingMode = ""
	require.ErrorContains(t, validatePricingOptionsRequest(request), "显式使用普通倍率计费")
}

func TestUpdatePricingOptionsMergesFromDatabaseInsteadOfStaleMemory(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	require.NoError(t, model.DB.Create([]model.Option{
		{Key: "ModelRatio", Value: `{"remote-model":3}`},
		{Key: "CacheRatio", Value: `{"remote-model":0.2}`},
		{Key: "CreateCacheRatio", Value: `{"remote-model":1.2}`},
	}).Error)
	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"stale-model":1}`))
	require.NoError(t, ratio_setting.UpdateCacheRatioByJSONString(`{"stale-model":0.1}`))
	require.NoError(t, ratio_setting.UpdateCreateCacheRatioByJSONString(`{"stale-model":1}`))

	response := callUpdatePricingOptions(t, `{
		"model_name": "sync-test",
		"model_ratio": 2,
		"cache_ratio": 0.1,
		"create_cache_ratio": 1
	}`)

	require.Equal(t, http.StatusOK, response.Code)
	var options []model.Option
	require.NoError(t, model.DB.Find(&options).Error)
	values := make(map[string]map[string]float64, len(options))
	for _, option := range options {
		var value map[string]float64
		require.NoError(t, common.UnmarshalJsonStr(option.Value, &value))
		values[option.Key] = value
	}
	for _, key := range []string{"ModelRatio", "CacheRatio", "CreateCacheRatio"} {
		assert.Contains(t, values[key], "remote-model")
		assert.Contains(t, values[key], "sync-test")
		assert.NotContains(t, values[key], "stale-model")
	}
}

func TestBuildPricingOptionValuesPreservesLockedCompletionRatio(t *testing.T) {
	lockedRatio := 2.0
	cacheRatio := 0.1
	createCacheRatio := 1.0
	values, keys, err := buildPricingOptionValues(PricingOptionsUpdateRequest{
		ModelName:        "gpt-5.4",
		ModelRatio:       2,
		CompletionRatio:  &lockedRatio,
		CacheRatio:       &cacheRatio,
		CreateCacheRatio: &createCacheRatio,
	})

	require.ErrorContains(t, err, "输出倍率由系统锁定")
	assert.Nil(t, values)
	assert.Nil(t, keys)
}

func TestBuildPricingOptionValuesUsesNormalizedPricingKey(t *testing.T) {
	originalModelPrice := ratio_setting.ModelPrice2JSONString()
	t.Cleanup(func() {
		require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(originalModelPrice))
	})
	require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(
		`{"gpt-4-gizmo-*":9,"other-model":1}`,
	))
	cacheRatio := 0.1
	createCacheRatio := 1.0

	values, _, err := buildPricingOptionValues(PricingOptionsUpdateRequest{
		ModelName:        "gpt-4-gizmo-example",
		ModelRatio:       2,
		CacheRatio:       &cacheRatio,
		CreateCacheRatio: &createCacheRatio,
	})

	require.NoError(t, err)
	var modelRatios map[string]float64
	require.NoError(t, common.UnmarshalJsonStr(values["ModelRatio"], &modelRatios))
	assert.Equal(t, 2.0, modelRatios["gpt-4-gizmo-*"])
	assert.NotContains(t, modelRatios, "gpt-4-gizmo-example")
	var cacheRatios map[string]float64
	require.NoError(t, common.UnmarshalJsonStr(values["CacheRatio"], &cacheRatios))
	assert.Equal(t, 0.1, cacheRatios["gpt-4-gizmo-example"])
	assert.NotContains(t, cacheRatios, "gpt-4-gizmo-*")
	var createCacheRatios map[string]float64
	require.NoError(t, common.UnmarshalJsonStr(
		values["CreateCacheRatio"],
		&createCacheRatios,
	))
	assert.Equal(t, 1.0, createCacheRatios["gpt-4-gizmo-example"])
	assert.NotContains(t, createCacheRatios, "gpt-4-gizmo-*")
	var modelPrices map[string]float64
	require.NoError(t, common.UnmarshalJsonStr(values["ModelPrice"], &modelPrices))
	assert.NotContains(t, modelPrices, "gpt-4-gizmo-*")
	assert.Equal(t, 1.0, modelPrices["other-model"])
}

func TestBuildPricingOptionValuesRejectsSharedCompactFixedPrice(t *testing.T) {
	originalModelPrice := ratio_setting.ModelPrice2JSONString()
	t.Cleanup(func() {
		require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(originalModelPrice))
	})
	require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(
		`{"*-openai-compact":9,"other-model":1}`,
	))
	cacheRatio := 0.1
	createCacheRatio := 1.0

	values, keys, err := buildPricingOptionValues(PricingOptionsUpdateRequest{
		ModelName:        "gpt-5-openai-compact",
		ModelRatio:       2,
		CacheRatio:       &cacheRatio,
		CreateCacheRatio: &createCacheRatio,
	})

	require.ErrorContains(t, err, "共享固定价格")
	assert.Nil(t, values)
	assert.Nil(t, keys)
}

func TestUpdatePricingOptionsRejectsTieredExpressionModel(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	saved := map[string]string{}
	require.NoError(t, config.GlobalConfig.SaveToDB(func(key, value string) error {
		saved[key] = value
		return nil
	}))
	t.Cleanup(func() {
		require.NoError(t, config.GlobalConfig.LoadFromDB(saved))
	})
	require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{
		"billing_setting.billing_mode": `{"tiered-model":"tiered_expr"}`,
	}))

	response := callUpdatePricingOptions(t, `{
		"model_name": "tiered-model",
		"model_ratio": 2,
		"cache_ratio": 0.1,
		"create_cache_ratio": 1
	}`)

	assert.Equal(t, http.StatusBadRequest, response.Code)
	assert.Contains(t, response.Body.String(), "分层计费表达式")
	var count int64
	require.NoError(t, model.DB.Model(&model.Option{}).Count(&count).Error)
	assert.Zero(t, count)
	assert.Equal(t, billing_setting.BillingModeTieredExpr, billing_setting.GetBillingMode("tiered-model"))
}

func TestUpdatePricingOptionsUsesDatabaseTieredModeWhenCacheSaysRatio(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	require.NoError(t, model.DB.Create(&model.Option{
		Key:   "billing_setting.billing_mode",
		Value: `{"db-tiered-model":"tiered_expr"}`,
	}).Error)
	require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{
		"billing_setting.billing_mode": `{}`,
	}))
	var persistedMode model.Option
	require.NoError(t, model.DB.First(&persistedMode, "key = ?", "billing_setting.billing_mode").Error)
	assert.JSONEq(t, `{"db-tiered-model":"tiered_expr"}`, persistedMode.Value)

	response := callUpdatePricingOptions(t, `{
		"model_name":"db-tiered-model",
		"model_ratio":2,
		"cache_ratio":0.1,
		"create_cache_ratio":1
	}`)

	assert.Equal(t, http.StatusBadRequest, response.Code)
	assert.Contains(t, response.Body.String(), "分层计费表达式")
}

func TestUpdatePricingOptionsUsesDatabaseRatioModeWhenCacheSaysTiered(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	require.NoError(t, model.DB.Create(&model.Option{
		Key:   "billing_setting.billing_mode",
		Value: `{"db-ratio-model":"ratio"}`,
	}).Error)
	require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{
		"billing_setting.billing_mode": `{"db-ratio-model":"tiered_expr"}`,
	}))

	response := callUpdatePricingOptions(t, `{
		"model_name":"db-ratio-model",
		"model_ratio":2,
		"cache_ratio":0.1,
		"create_cache_ratio":1
	}`)

	assert.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var option model.Option
	require.NoError(t, model.DB.First(&option, "key = ?", "billing_setting.billing_mode").Error)
	assert.JSONEq(t, `{"db-ratio-model":"ratio"}`, option.Value)
}

func TestLocalPricingSyncDataReadsTieredConfigFromRuntimeSnapshot(t *testing.T) {
	setupPricingOptionTestDB(t)
	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"sync-data-model":9}`))
	require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{
		"billing_setting.billing_mode": `{"sync-data-model":"tiered_expr"}`,
		"billing_setting.billing_expr": `{"sync-data-model":"tier(\"sync\", p * 9)"}`,
	}))

	data := getLocalPricingSyncData()

	assert.Equal(t, 9.0, data["model_ratio"].(map[string]float64)["sync-data-model"])
	assert.Equal(t, billing_setting.BillingModeTieredExpr,
		data[billing_setting.BillingModeField].(map[string]string)["sync-data-model"])
	assert.Equal(t, `tier("sync", p * 9)`,
		data[billing_setting.BillingExprField].(map[string]string)["sync-data-model"])
}

func TestUpdatePricingOptionsAtomicallySwitchesTieredModelToRatio(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{
		"billing_setting.billing_mode": `{"tiered-model":"tiered_expr","other-model":"tiered_expr"}`,
		"billing_setting.billing_expr": `{"tiered-model":"tier(\"base\", p * 2 + c * 8)","other-model":"tier(\"base\", p)"}`,
	}))
	require.NoError(t, model.DB.Create(&model.Channel{
		Id:     31,
		Name:   "manual-price-channel",
		Models: "tiered-model",
		Status: common.ChannelStatusEnabled,
		OtherSettings: `{
			"upstream_pricing_source":"newapi",
			"model_prices":{
				"tiered-model":{
					"input":3,
					"output":13.5,
					"cache_read":0.3,
					"cache_write":3.75,
					"source":"manual"
				}
			}
		}`,
	}).Error)
	require.NoError(t, model.DB.Create([]model.Option{
		{Key: "ModelRatio", Value: `{"tiered-model":9,"other-model":1}`},
		{Key: "CompletionRatio", Value: `{"tiered-model":9,"other-model":2}`},
		{Key: "CacheRatio", Value: `{"tiered-model":9,"other-model":0.2}`},
		{Key: "CreateCacheRatio", Value: `{"tiered-model":9,"other-model":1}`},
		{Key: "ModelPrice", Value: `{"other-model":1}`},
		{Key: "billing_setting.billing_mode", Value: `{"tiered-model":"tiered_expr","other-model":"tiered_expr"}`},
		{Key: "billing_setting.billing_expr", Value: `{"tiered-model":"tier(\"base\", p * 2 + c * 8)","other-model":"tier(\"base\", p)"}`},
	}).Error)

	response := callUpdatePricingOptions(t, `{
		"model_name": "tiered-model",
		"billing_mode": "ratio",
		"model_ratio": 2,
		"completion_ratio": 4.5,
		"cache_ratio": 0.1,
		"create_cache_ratio": 1.25,
		"channel_id": 31
	}`)

	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var options []model.Option
	require.NoError(t, model.DB.Find(&options).Error)
	values := make(map[string]string, len(options))
	for _, option := range options {
		values[option.Key] = option.Value
	}
	for key, expected := range map[string][2]float64{
		"ModelRatio":       {2, 1},
		"CompletionRatio":  {4.5, 2},
		"CacheRatio":       {0.1, 0.2},
		"CreateCacheRatio": {1.25, 1},
	} {
		var ratios map[string]float64
		require.NoError(t, common.UnmarshalJsonStr(values[key], &ratios))
		assert.Equal(t, expected[0], ratios["tiered-model"])
		assert.Equal(t, expected[1], ratios["other-model"])
	}
	var modelPrices map[string]float64
	require.NoError(t, common.UnmarshalJsonStr(values["ModelPrice"], &modelPrices))
	assert.Equal(t, 1.0, modelPrices["other-model"])
	var modes map[string]string
	require.NoError(t, common.UnmarshalJsonStr(values["billing_setting.billing_mode"], &modes))
	assert.NotContains(t, modes, "tiered-model")
	assert.Equal(t, billing_setting.BillingModeTieredExpr, modes["other-model"])
	var expressions map[string]string
	require.NoError(t, common.UnmarshalJsonStr(values["billing_setting.billing_expr"], &expressions))
	assert.NotContains(t, expressions, "tiered-model")
	assert.Equal(t, `tier("base", p)`, expressions["other-model"])

	var channel model.Channel
	require.NoError(t, model.DB.First(&channel, 31).Error)
	settings := channel.GetOtherSettings()
	assert.Equal(t, "newapi", settings.UpstreamPricingSource)
	price := settings.ModelPrices["tiered-model"]
	assert.Equal(t, "manual", price.Source)
	assert.Equal(t, 3.0, *price.Input)
	assert.Equal(t, 13.5, *price.Output)
	assert.Equal(t, 0.3, *price.CacheRead)
	assert.Equal(t, 3.75, *price.CacheWrite)
}

func TestUpdatePricingOptionsRollsBackRatioSwitchWhenOptionWriteFails(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{
		"billing_setting.billing_mode": `{"tiered-model":"tiered_expr","other-model":"tiered_expr"}`,
		"billing_setting.billing_expr": `{"tiered-model":"tier(\"base\", p * 2 + c * 8)","other-model":"tier(\"base\", p)"}`,
	}))
	require.NoError(t, model.DB.Create(&model.Channel{
		Id: 31, Name: "manual-price-channel", Models: "tiered-model",
		Status:        common.ChannelStatusEnabled,
		OtherSettings: `{"upstream_pricing_source":"newapi","model_prices":{"tiered-model":{"input":3,"output":13.5,"cache_read":0.3,"cache_write":3.75,"source":"manual"}}}`,
	}).Error)
	require.NoError(t, model.DB.Create([]model.Option{
		{Key: "ModelRatio", Value: `{"tiered-model":9,"other-model":1}`},
		{Key: "CompletionRatio", Value: `{"tiered-model":9,"other-model":2}`},
		{Key: "CacheRatio", Value: `{"tiered-model":9,"other-model":0.2}`},
		{Key: "CreateCacheRatio", Value: `{"tiered-model":9,"other-model":1}`},
		{Key: "ModelPrice", Value: `{"other-model":1}`},
		{Key: "billing_setting.billing_mode", Value: `{"tiered-model":"tiered_expr","other-model":"tiered_expr"}`},
		{Key: "billing_setting.billing_expr", Value: `{"tiered-model":"tier(\"base\", p * 2 + c * 8)","other-model":"tier(\"base\", p)"}`},
	}).Error)
	var beforeOptions []model.Option
	require.NoError(t, model.DB.Order("key").Find(&beforeOptions).Error)
	require.Len(t, beforeOptions, 7)
	var beforeChannel model.Channel
	require.NoError(t, model.DB.First(&beforeChannel, 31).Error)

	writeCount, injectedFailure := failSecondPricingOptionUpdate(t)

	response := callUpdatePricingOptions(t, `{"model_name":"tiered-model","billing_mode":"ratio","model_ratio":2,"completion_ratio":4.5,"cache_ratio":0.1,"create_cache_ratio":1.25,"channel_id":31}`)
	var payload struct {
		Success bool `json:"success"`
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &payload))
	assert.False(t, payload.Success)
	assert.Contains(t, response.Body.String(), injectedFailure.Error())
	assert.Equal(t, 2, *writeCount)
	var afterOptions []model.Option
	require.NoError(t, model.DB.Order("key").Find(&afterOptions).Error)
	assert.Equal(t, beforeOptions, afterOptions)
	var afterChannel model.Channel
	require.NoError(t, model.DB.First(&afterChannel, 31).Error)
	assert.Equal(t, beforeChannel.OtherSettings, afterChannel.OtherSettings)
}

func TestUpdatePricingOptionsAtomicallyWritesGrok46UnifiedPurchasePrice(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	seedGrok46TieredPricing(t)

	response := callUpdatePricingOptions(t, grok46UnifiedPricingRequest)

	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var options []model.Option
	require.NoError(t, model.DB.Find(&options).Error)
	values := make(map[string]string, len(options))
	for _, option := range options {
		values[option.Key] = option.Value
	}
	for key, expected := range map[string]float64{
		"ModelRatio":       38.25,
		"CompletionRatio":  5,
		"CacheRatio":       0.1,
		"CreateCacheRatio": 1.25,
	} {
		var ratios map[string]float64
		require.NoError(t, common.UnmarshalJsonStr(values[key], &ratios))
		assert.Equal(t, expected, ratios["grok-4.6"])
		assert.Contains(t, ratios, "other-model")
	}
	var modes map[string]string
	require.NoError(t, common.UnmarshalJsonStr(values["billing_setting.billing_mode"], &modes))
	assert.NotContains(t, modes, "grok-4.6")
	assert.Equal(t, billing_setting.BillingModeTieredExpr, modes["other-model"])
	var expressions map[string]string
	require.NoError(t, common.UnmarshalJsonStr(values["billing_setting.billing_expr"], &expressions))
	assert.NotContains(t, expressions, "grok-4.6")
	assert.Equal(t, `tier("base", p)`, expressions["other-model"])
	assert.Equal(t, billing_setting.BillingModeRatio, billing_setting.GetBillingMode("grok-4.6"))

	var channel model.Channel
	require.NoError(t, model.DB.First(&channel, 31).Error)
	settings := channel.GetOtherSettings()
	assert.Equal(t, "models_dev", settings.UpstreamPricingSource)
	price := settings.ModelPrices["grok-4.6"]
	assert.Equal(t, "manual", price.Source)
	assert.Empty(t, price.Provider)
	assert.Nil(t, price.Tiers)
	assert.Equal(t, 1.5, *price.Input)
	assert.Equal(t, 7.5, *price.Output)
	assert.Equal(t, 0.15, *price.CacheRead)
	assert.Equal(t, 1.875, *price.CacheWrite)
	otherPrice := settings.ModelPrices["other-model"]
	assert.Equal(t, "manual", otherPrice.Source)
	assert.Equal(t, 2.0, *otherPrice.Input)
	assert.Equal(t, 8.0, *otherPrice.Output)
}

func TestUpdatePricingOptionsRollsBackGrok46RatioWhenPurchasePriceWriteFails(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	seedGrok46TieredPricing(t)
	var beforeOptions []model.Option
	require.NoError(t, model.DB.Order("key").Find(&beforeOptions).Error)
	var beforeChannel model.Channel
	require.NoError(t, model.DB.First(&beforeChannel, 31).Error)

	injectedFailure := errors.New("injected channel purchase price write failure")
	callbackName := "test:fail_grok_purchase_price_write"
	require.NoError(t, model.DB.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Table == "channels" {
			tx.AddError(injectedFailure)
		}
	}))
	t.Cleanup(func() { require.NoError(t, model.DB.Callback().Update().Remove(callbackName)) })

	response := callUpdatePricingOptions(t, grok46UnifiedPricingRequest)

	require.Equal(t, http.StatusOK, response.Code)
	var payload struct {
		Success bool `json:"success"`
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &payload))
	assert.False(t, payload.Success)
	assert.Contains(t, response.Body.String(), injectedFailure.Error())
	var afterOptions []model.Option
	require.NoError(t, model.DB.Order("key").Find(&afterOptions).Error)
	assert.Equal(t, beforeOptions, afterOptions)
	var afterChannel model.Channel
	require.NoError(t, model.DB.First(&afterChannel, 31).Error)
	assert.Equal(t, beforeChannel.OtherSettings, afterChannel.OtherSettings)
}

func TestUpdatePricingOptionsPreservesMalformedChannelSettingsWhenGrok46WriteFails(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	seedGrok46TieredPricing(t)
	require.NoError(t, model.DB.Model(&model.Channel{}).Where("id = ?", 31).Update("settings", "{").Error)
	var beforeOptions []model.Option
	require.NoError(t, model.DB.Order("key").Find(&beforeOptions).Error)

	response := callUpdatePricingOptions(t, grok46UnifiedPricingRequest)

	require.Equal(t, http.StatusOK, response.Code)
	var payload struct {
		Success bool `json:"success"`
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &payload))
	assert.False(t, payload.Success)
	assert.Contains(t, response.Body.String(), "invalid channel settings")
	var afterOptions []model.Option
	require.NoError(t, model.DB.Order("key").Find(&afterOptions).Error)
	assert.Equal(t, beforeOptions, afterOptions)
	var channel model.Channel
	require.NoError(t, model.DB.First(&channel, 31).Error)
	assert.Equal(t, "{", channel.OtherSettings)
}

func TestUpdatePricingOptionsRejectsUnsafeGrok46UnifiedPurchasePrice(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "missing input", body: strings.Replace(grok46UnifiedPricingRequest, `"input":1.5,`, "", 1)},
		{name: "missing output", body: strings.Replace(grok46UnifiedPricingRequest, `"output":7.5,`, "", 1)},
		{name: "missing cache read", body: strings.Replace(grok46UnifiedPricingRequest, `"cache_read":0.15,`, "", 1)},
		{name: "missing cache write", body: strings.Replace(grok46UnifiedPricingRequest, `"cache_write":1.875,`, "", 1)},
		{name: "zero input", body: strings.Replace(grok46UnifiedPricingRequest, `"input":1.5`, `"input":0`, 1)},
		{name: "negative output", body: strings.Replace(grok46UnifiedPricingRequest, `"output":7.5`, `"output":-1`, 1)},
		{name: "official source", body: strings.Replace(grok46UnifiedPricingRequest, `"source":"manual"`, `"source":"models_dev","provider":"xai"`, 1)},
		{name: "provider", body: strings.Replace(grok46UnifiedPricingRequest, `"source":"manual"`, `"source":"manual","provider":"xai"`, 1)},
		{name: "top level provider", body: strings.Replace(grok46UnifiedPricingRequest, `"channel_id":31,`, `"channel_id":31,"upstream_provider":"xai",`, 1)},
		{name: "empty tiers field", body: strings.Replace(grok46UnifiedPricingRequest, `"source":"manual"`, `"source":"manual","tiers":[]`, 1)},
		{name: "tier", body: strings.Replace(grok46UnifiedPricingRequest, `"source":"manual"`, `"source":"manual","tiers":[{"name":"context_200000","context_threshold":200000,"input":1.5,"output":7.5,"cache_read":0.15,"cache_write":1.875}]`, 1)},
		{name: "billing expression", body: strings.Replace(grok46UnifiedPricingRequest, `"billing_mode":"ratio",`, `"billing_mode":"ratio","billing_expr":"tier(\"base\", p)",`, 1)},
		{name: "missing channel", body: strings.Replace(grok46UnifiedPricingRequest, `"channel_id":31,`, "", 1)},
		{name: "similar model", body: strings.Replace(grok46UnifiedPricingRequest, `"model_name":"grok-4.6"`, `"model_name":"grok-4.6-preview"`, 1)},
		{name: "uppercase model", body: strings.Replace(grok46UnifiedPricingRequest, `"model_name":"grok-4.6"`, `"model_name":"GROK-4.6"`, 1)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			setupPricingOptionTestDB(t)
			seedGrok46TieredPricing(t)
			var beforeOptions []model.Option
			require.NoError(t, model.DB.Order("key").Find(&beforeOptions).Error)
			var beforeChannel model.Channel
			require.NoError(t, model.DB.First(&beforeChannel, 31).Error)

			response := callUpdatePricingOptions(t, test.body)

			assert.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			var afterOptions []model.Option
			require.NoError(t, model.DB.Order("key").Find(&afterOptions).Error)
			assert.Equal(t, beforeOptions, afterOptions)
			var afterChannel model.Channel
			require.NoError(t, model.DB.First(&afterChannel, 31).Error)
			assert.Equal(t, beforeChannel.OtherSettings, afterChannel.OtherSettings)
		})
	}
}

func TestValidatePricingOptionsRequestAllowsZeroGrok46OutputAndCacheCosts(t *testing.T) {
	input := 1.5
	zero := 0.0
	cacheRatio := 0.0
	createCacheRatio := 0.0
	completionRatio := 0.0

	err := validatePricingOptionsRequest(PricingOptionsUpdateRequest{
		ModelName:        "grok-4.6",
		ModelRatio:       38.25,
		CompletionRatio:  &completionRatio,
		CacheRatio:       &cacheRatio,
		CreateCacheRatio: &createCacheRatio,
		BillingMode:      billing_setting.BillingModeRatio,
		ChannelID:        31,
		PurchasePrice: &dto.ChannelModelPrice{
			Input:      &input,
			Output:     &zero,
			CacheRead:  &zero,
			CacheWrite: &zero,
			Source:     "manual",
		},
	})

	require.NoError(t, err)
}

func TestValidatePricingOptionsRequestRejectsNonFiniteGrok46PurchaseCosts(t *testing.T) {
	tests := []struct {
		name  string
		value float64
	}{
		{name: "nan", value: math.NaN()},
		{name: "positive infinity", value: math.Inf(1)},
		{name: "negative infinity", value: math.Inf(-1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := 1.5
			output := 7.5
			cacheRead := test.value
			cacheWrite := 1.875
			cacheRatio := 0.1
			createCacheRatio := 1.25
			err := validatePricingOptionsRequest(PricingOptionsUpdateRequest{
				ModelName:        "grok-4.6",
				ModelRatio:       38.25,
				CacheRatio:       &cacheRatio,
				CreateCacheRatio: &createCacheRatio,
				BillingMode:      billing_setting.BillingModeRatio,
				ChannelID:        31,
				PurchasePrice: &dto.ChannelModelPrice{
					Input:      &input,
					Output:     &output,
					CacheRead:  &cacheRead,
					CacheWrite: &cacheWrite,
					Source:     "manual",
				},
			})

			require.Error(t, err)
		})
	}
}

func TestUpdatePricingOptionsAtomicallyWritesOfficialTieredPrice(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	require.NoError(t, model.DB.Create(&model.Channel{
		Id:            31,
		Name:          "1x-sub-openai",
		Models:        "gpt-5.6-sol",
		Status:        common.ChannelStatusEnabled,
		OtherSettings: `{"pac_upstream_group":"default"}`,
	}).Error)
	require.NoError(t, model.DB.Create([]model.Option{
		{Key: "ModelRatio", Value: `{"gpt-5.6-sol":2,"other":1}`},
		{Key: "CompletionRatio", Value: `{"gpt-5.6-sol":6,"other":2}`},
		{Key: "CacheRatio", Value: `{"gpt-5.6-sol":0.1,"other":0.2}`},
		{Key: "CreateCacheRatio", Value: `{"gpt-5.6-sol":1.25,"other":1}`},
		{Key: "ModelPrice", Value: `{"gpt-5.6-sol":9,"other":1}`},
		{Key: "billing_setting.billing_mode", Value: `{"other":"tiered_expr"}`},
		{Key: "billing_setting.billing_expr", Value: `{"other":"tier(\"base\", p)"}`},
	}).Error)

	response := callUpdatePricingOptions(t, `{
		"model_name": "gpt-5.6-sol",
		"billing_mode": "tiered_expr",
		"billing_expr": "len < 272000 ? tier(\"base\", p * 7.142857143 + c * 42.857142857) : tier(\"context_272000\", p * 14.285714286 + c * 64.285714286)",
		"channel_id": 31,
		"upstream_provider": "openai",
		"purchase_price": {
			"input": 5,
			"output": 30,
			"cache_read": 0.5,
			"cache_write": 6.25,
			"source": "models_dev",
			"provider": "openai",
			"tiers": [{
				"name": "context_272000",
				"context_threshold": 272000,
				"input": 10,
				"output": 45,
				"cache_read": 1,
				"cache_write": 12.5
			}]
		}
	}`)

	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var options []model.Option
	require.NoError(t, model.DB.Find(&options).Error)
	values := make(map[string]string, len(options))
	for _, option := range options {
		values[option.Key] = option.Value
	}
	for _, key := range []string{"ModelRatio", "CompletionRatio", "CacheRatio", "CreateCacheRatio", "ModelPrice"} {
		var value map[string]float64
		require.NoError(t, common.UnmarshalJsonStr(values[key], &value))
		assert.NotContains(t, value, "gpt-5.6-sol")
		assert.Contains(t, value, "other")
	}
	var modes map[string]string
	require.NoError(t, common.UnmarshalJsonStr(values["billing_setting.billing_mode"], &modes))
	assert.Equal(t, billing_setting.BillingModeTieredExpr, modes["gpt-5.6-sol"])
	var expressions map[string]string
	require.NoError(t, common.UnmarshalJsonStr(values["billing_setting.billing_expr"], &expressions))
	assert.Contains(t, expressions["gpt-5.6-sol"], "context_272000")

	var channel model.Channel
	require.NoError(t, model.DB.First(&channel, 31).Error)
	settings := channel.GetOtherSettings()
	assert.Equal(t, "default", settings.PACUpstreamGroup)
	price := settings.ModelPrices["gpt-5.6-sol"]
	assert.Equal(t, "models_dev", price.Source)
	assert.Equal(t, 5.0, *price.Input)
	require.Len(t, price.Tiers, 1)
	assert.Equal(t, 45.0, price.Tiers[0].Output)
}

func TestUpdatePricingOptionsRejectsInvalidOfficialTieredExpression(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	require.NoError(t, model.DB.Create(&model.Channel{
		Id:            31,
		Name:          "1x-sub-openai",
		Models:        "gpt-5.6-sol",
		Status:        common.ChannelStatusEnabled,
		OtherSettings: `{}`,
	}).Error)

	response := callUpdatePricingOptions(t, `{
		"model_name": "gpt-5.6-sol",
		"billing_mode": "tiered_expr",
		"billing_expr": "invalid +-+ expression",
		"channel_id": 31,
		"upstream_provider": "openai",
		"purchase_price": {
			"input": 5,
			"output": 30,
			"cache_read": 0.5,
			"cache_write": 6.25,
			"source": "models_dev",
			"provider": "openai"
		}
	}`)

	assert.Equal(t, http.StatusBadRequest, response.Code)
	var count int64
	require.NoError(t, model.DB.Model(&model.Option{}).Count(&count).Error)
	assert.Zero(t, count)
	var channel model.Channel
	require.NoError(t, model.DB.First(&channel, 31).Error)
	assert.Empty(t, channel.GetOtherSettings().ModelPrices)
}
func TestUpdatePricingOptionsRejectsNonCanonicalOfficialProvider(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	require.NoError(t, model.DB.Create(&model.Channel{
		Id:            31,
		Name:          "reseller",
		Models:        "gpt-5.6-sol",
		Status:        common.ChannelStatusEnabled,
		OtherSettings: `{}`,
	}).Error)

	response := callUpdatePricingOptions(t, `{
		"model_name": "gpt-5.6-sol",
		"billing_mode": "tiered_expr",
		"billing_expr": "tier(\"base\", p)",
		"channel_id": 31,
		"upstream_provider": "reseller",
		"purchase_price": {
			"input": 5,
			"output": 30,
			"cache_read": 0.5,
			"cache_write": 6.25,
			"source": "models_dev",
			"provider": "reseller"
		}
	}`)

	assert.Equal(t, http.StatusBadRequest, response.Code)
	assert.Contains(t, response.Body.String(), "提供商无效")
	var count int64
	require.NoError(t, model.DB.Model(&model.Option{}).Count(&count).Error)
	assert.Zero(t, count)
	var channel model.Channel
	require.NoError(t, model.DB.First(&channel, 31).Error)
	assert.Empty(t, channel.GetOtherSettings().ModelPrices)
}

func TestUpdateOptionRejectsInvalidCreateCacheRatioBeforePersisting(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Set("id", 1)
	context.Request = httptest.NewRequest(
		http.MethodPut,
		"/api/option/",
		strings.NewReader(`{"key":"CreateCacheRatio","value":"{"}`),
	)

	UpdateOption(context)

	var count int64
	require.NoError(t, model.DB.Model(&model.Option{}).Count(&count).Error)
	assert.Zero(t, count)
}

func TestUpdatePricingOptionsReturnsConflictForDuplicatePricingRows(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)
	require.NoError(t, model.DB.Migrator().DropTable(&model.Option{}))
	require.NoError(t, model.DB.Exec("CREATE TABLE options (`key` text, `value` text)").Error)
	require.NoError(t, model.DB.Exec(
		"INSERT INTO options (`key`, `value`) VALUES (?, ?), (?, ?)",
		"ModelRatio", `{}`, "ModelRatio", `{}`,
	).Error)

	response := callUpdatePricingOptions(t, `{
		"model_name": "duplicate-model",
		"model_ratio": 2,
		"completion_ratio": 4,
		"cache_ratio": 0.1,
		"create_cache_ratio": 1
	}`)

	assert.Equal(t, http.StatusConflict, response.Code)
	assert.Contains(t, response.Body.String(), "请重试")
}

func TestBuildPricingOptionValuesIncludesUnchangedModelPriceForConflictCheck(t *testing.T) {
	cacheRatio := 0.1
	createCacheRatio := 1.0
	values, keys, err := buildPricingOptionValuesFromCurrent(
		PricingOptionsUpdateRequest{
			ModelName:        "ratio-model",
			ModelRatio:       2,
			CacheRatio:       &cacheRatio,
			CreateCacheRatio: &createCacheRatio,
		},
		map[string]string{
			"ModelRatio":       "{}",
			"CacheRatio":       "{}",
			"CreateCacheRatio": "{}",
			"ModelPrice":       `{"fixed-model":9}`,
		},
	)

	require.NoError(t, err)
	assert.Contains(t, keys, "ModelPrice")
	assert.JSONEq(t, `{"fixed-model":9}`, values["ModelPrice"])
}

func TestBuildPricingOptionValuesRejectsNullPricingMap(t *testing.T) {
	cacheRatio := 0.1
	createCacheRatio := 1.0

	values, keys, err := buildPricingOptionValuesFromCurrent(
		PricingOptionsUpdateRequest{
			ModelName:        "null-map-model",
			ModelRatio:       2,
			CacheRatio:       &cacheRatio,
			CreateCacheRatio: &createCacheRatio,
		},
		map[string]string{
			"ModelRatio":       "null",
			"CacheRatio":       "{}",
			"CreateCacheRatio": "{}",
			"ModelPrice":       "{}",
		},
	)

	require.ErrorContains(t, err, "必须是 JSON 对象")
	assert.Nil(t, values)
	assert.Nil(t, keys)
}

func TestGetOptionsIncludesRequestedModelPricingMetadata(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)

	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Request = httptest.NewRequest(
		http.MethodGet,
		"/api/option/?model=gpt-5.4",
		nil,
	)
	GetOptions(context)

	assert.Equal(t, http.StatusOK, response.Code)
	var payload struct {
		Success bool            `json:"success"`
		Data    []*model.Option `json:"data"`
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &payload))
	require.True(t, payload.Success)
	optionValues := make(map[string]string, len(payload.Data))
	for _, option := range payload.Data {
		optionValues[option.Key] = option.Value
	}
	assert.Equal(t, "gpt-5.4", optionValues["PricingModelKey"])
	var completionMeta map[string]ratio_setting.CompletionRatioInfo
	require.NoError(t, common.UnmarshalJsonStr(
		optionValues["CompletionRatioMeta"],
		&completionMeta,
	))
	assert.Equal(t, ratio_setting.CompletionRatioInfo{
		Ratio:  6,
		Locked: true,
	}, completionMeta["gpt-5.4"])
}

func TestUpdatePricingOptionsRejectsNegativeRatios(t *testing.T) {
	gin.SetMode(gin.TestMode)
	setupPricingOptionTestDB(t)

	response := callUpdatePricingOptions(t, `{
		"model_name": "sync-test",
		"model_ratio": -1,
		"cache_ratio": 0.1,
		"create_cache_ratio": 1
	}`)

	assert.Equal(t, http.StatusBadRequest, response.Code)
	var count int64
	require.NoError(t, model.DB.Model(&model.Option{}).Count(&count).Error)
	assert.Zero(t, count)
}

func TestUpdatePricingOptionsRejectsMissingCacheRatios(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{
			name: "cache read ratio",
			body: `{
				"model_name": "sync-test",
				"model_ratio": 2,
				"create_cache_ratio": 1
			}`,
		},
		{
			name: "cache write ratio",
			body: `{
				"model_name": "sync-test",
				"model_ratio": 2,
				"cache_ratio": 0.1
			}`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			setupPricingOptionTestDB(t)

			response := callUpdatePricingOptions(t, test.body)

			assert.Equal(t, http.StatusBadRequest, response.Code)
			var count int64
			require.NoError(t, model.DB.Model(&model.Option{}).Count(&count).Error)
			assert.Zero(t, count)
		})
	}
}
