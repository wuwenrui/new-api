package controller

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
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
