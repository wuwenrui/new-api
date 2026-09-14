package controller

import (
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

type billingResponse struct {
	Success bool   `json:"success"`
	Code    string `json:"code"`
	Data    struct {
		Version      int     `json:"version"`
		ObservedAt   int64   `json:"observed_at"`
		QuotaPerUnit float64 `json:"quota_per_unit"`
		Display      struct {
			Type string  `json:"type"`
			Rate float64 `json:"exchange_rate"`
		} `json:"display"`
		Account struct {
			Remaining int `json:"remaining_quota"`
		} `json:"account"`
		Token struct {
			Remaining *int `json:"remaining_quota"`
			Used      int  `json:"used_quota"`
			Unlimited bool `json:"unlimited"`
		} `json:"token"`
		Pricing struct {
			Model  *string `json:"model"`
			Status string  `json:"status"`
			Reason *string `json:"reason"`
			Rates  []struct {
				Group      string   `json:"group"`
				Input      float64  `json:"input_quota_per_token"`
				Output     float64  `json:"output_quota_per_token"`
				CacheRead  *float64 `json:"cache_read_quota_per_token"`
				CacheWrite *float64 `json:"cache_write_quota_per_token"`
			} `json:"rates"`
		} `json:"pricing"`
	} `json:"data"`
}

func setupBillingEndpoint(t *testing.T) (*gin.Engine, *model.User, *model.Token) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	oldDB, oldRedis := model.DB, common.RedisEnabled
	initModelListColumnNames(t) // Existing isolated SQLite startup initializes quoted token columns.
	oldUnit, oldExchange := common.QuotaPerUnit, operation_setting.USDExchangeRate
	oldGeneral := *operation_setting.GetGeneralSetting()
	oldSelfUse := operation_setting.SelfUseModeEnabled
	saved := map[string]string{}
	require.NoError(t, config.GlobalConfig.SaveToDB(func(k, v string) error { saved[k] = v; return nil }))
	oldRatios, oldCompletion := ratio_setting.ModelRatio2JSONString(), ratio_setting.CompletionRatio2JSONString()
	oldPrice, oldCache := ratio_setting.ModelPrice2JSONString(), ratio_setting.CacheRatio2JSONString()
	oldGroups, oldOverrides := ratio_setting.GroupRatio2JSONString(), ratio_setting.GroupGroupRatio2JSONString()
	oldAuto, oldUsable := setting.AutoGroups2JsonString(), setting.UserUsableGroups2JSONString()
	db, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", t.Name())), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	model.DB, common.RedisEnabled = db, false
	common.QuotaPerUnit, operation_setting.USDExchangeRate = 700000, 7.2
	operation_setting.GetGeneralSetting().QuotaDisplayType = "CNY"
	operation_setting.SelfUseModeEnabled = false
	require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{"billing_setting.billing_mode": "{}", "billing_setting.billing_expr": "{}", "peak_ratio_setting.enabled": "false"}))
	ratio_setting.ReloadPeakRatioFromSetting()
	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"billing-test":2,"zero-test":0}`))
	require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(`{"billing-test":3,"zero-test":0}`))
	require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(`{}`))
	require.NoError(t, ratio_setting.UpdateCacheRatioByJSONString(`{"billing-test":0.25}`))
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1,"vip":4}`))
	require.NoError(t, ratio_setting.UpdateGroupGroupRatioByJSONString(`{"default":{"vip":0.5}}`))
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"default":"Default","vip":"VIP","auto":"Auto"}`))
	require.NoError(t, setting.UpdateAutoGroupsByJsonString(`["default","vip"]`))
	t.Cleanup(func() {
		model.DB, common.RedisEnabled = oldDB, oldRedis
		common.QuotaPerUnit, operation_setting.USDExchangeRate = oldUnit, oldExchange
		operation_setting.SelfUseModeEnabled = oldSelfUse
		require.NoError(t, config.GlobalConfig.LoadFromDB(saved))
		ratio_setting.ReloadPeakRatioFromSetting()
		*operation_setting.GetGeneralSetting() = oldGeneral
		require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(oldRatios))
		require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(oldCompletion))
		require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(oldPrice))
		require.NoError(t, ratio_setting.UpdateCacheRatioByJSONString(oldCache))
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(oldGroups))
		require.NoError(t, ratio_setting.UpdateGroupGroupRatioByJSONString(oldOverrides))
		require.NoError(t, setting.UpdateAutoGroupsByJsonString(oldAuto))
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(oldUsable))
		require.NoError(t, sqlDB.Close())
	})
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Token{}, &model.Ability{}, &model.Channel{}))
	user := &model.User{Id: 901, Username: "billing-owner", Group: "default", Status: common.UserStatusEnabled, Quota: 7000000}
	token := &model.Token{Id: 902, UserId: user.Id, Key: "billingfixture", Group: "vip", Status: common.TokenStatusEnabled, RemainQuota: 3000, UsedQuota: 500, ExpiredTime: -1}
	require.NoError(t, db.Create(user).Error)
	require.NoError(t, db.Create(token).Error)
	require.NoError(t, db.Create(&model.Channel{Id: 903, Type: constant.ChannelTypeOpenAI, Key: "fake-upstream-never-used", Name: "private-channel"}).Error)
	for _, name := range []string{"billing-test", "zero-test", "missing-test"} {
		for _, group := range []string{"default", "vip"} {
			require.NoError(t, db.Create(&model.Ability{Group: group, Model: name, ChannelId: 903, Enabled: true}).Error)
		}
	}
	engine := gin.New()
	engine.GET("/api/usage/token/billing", middleware.DisableCache(), middleware.TokenAuthReadOnly(), GetTokenBilling)
	return engine, user, token
}

func requestBilling(t *testing.T, engine *gin.Engine, query, auth string, status int) billingResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/usage/token/billing"+query, nil)
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	require.Equal(t, status, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Header().Get("Cache-Control"), "no-store")
	var result billingResponse
	require.NoError(t, common.Unmarshal(rec.Body.Bytes(), &result))
	for _, secret := range []string{"billingfixture", "private-channel", "fake-upstream-never-used", "billing-owner", "billing_expr", "channel_id"} {
		assert.NotContains(t, rec.Body.String(), secret)
	}
	return result
}

func TestTokenBillingContractAndReadOnly(t *testing.T) {
	engine, _, _ := setupBillingEndpoint(t)
	writes := 0
	denyWrite := func(db *gorm.DB) { writes++; db.AddError(fmt.Errorf("billing endpoint attempted a write")) }
	t.Cleanup(func() { assert.Zero(t, writes, "read-only endpoint must not attempt writes, even ignored ones") })
	require.NoError(t, model.DB.Callback().Create().Before("gorm:create").Register("billing-read-only", denyWrite))
	require.NoError(t, model.DB.Callback().Update().Before("gorm:update").Register("billing-read-only", denyWrite))
	require.NoError(t, model.DB.Callback().Delete().Before("gorm:delete").Register("billing-read-only", denyWrite))
	result := requestBilling(t, engine, "?model=billing-test", "Bearer sk-billingfixture", 200)
	require.True(t, result.Success)
	assert.Equal(t, 1, result.Data.Version)
	assert.Positive(t, result.Data.ObservedAt)
	assert.Equal(t, float64(700000), result.Data.QuotaPerUnit)
	assert.Equal(t, "CNY", result.Data.Display.Type)
	assert.Equal(t, 7.2, result.Data.Display.Rate)
	assert.Equal(t, 7000000, result.Data.Account.Remaining)
	require.NotNil(t, result.Data.Token.Remaining)
	assert.Equal(t, 3000, *result.Data.Token.Remaining)
	assert.Equal(t, 500, result.Data.Token.Used)
	assert.False(t, result.Data.Token.Unlimited)
	assert.Equal(t, "available", result.Data.Pricing.Status)
	assert.Nil(t, result.Data.Pricing.Reason)
	require.Len(t, result.Data.Pricing.Rates, 1)
	rate := result.Data.Pricing.Rates[0]
	assert.Equal(t, "vip", rate.Group)
	assert.Equal(t, 1.0, rate.Input)
	assert.Equal(t, 3.0, rate.Output)
	require.NotNil(t, rate.CacheRead)
	assert.Equal(t, 0.25, *rate.CacheRead)
	assert.Nil(t, rate.CacheWrite)
}

func TestTokenBillingAuthAndOwnerIsolation(t *testing.T) {
	engine, user, token := setupBillingEndpoint(t)
	requestBilling(t, engine, "", "", 401)
	requestBilling(t, engine, "", "Bearer sk-unknown", 401)
	for _, key := range []string{"user_id", "token_id", "group"} {
		requestBilling(t, engine, "?"+key+"=123", "Bearer sk-billingfixture", 400)
	}
	require.NoError(t, model.DB.Model(token).Update("status", common.TokenStatusDisabled).Error)
	requestBilling(t, engine, "", "Bearer sk-billingfixture", 401)
	require.NoError(t, model.DB.Model(token).Update("status", common.TokenStatusEnabled).Error)
	require.NoError(t, model.DB.Model(user).Update("status", common.UserStatusDisabled).Error)
	requestBilling(t, engine, "", "Bearer sk-billingfixture", 403)
	// Even incorrectly assembled trusted context cannot read another owner's token.
	rec := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(rec)
	ctx.Request = httptest.NewRequest("GET", "/api/usage/token/billing", nil)
	ctx.Set("id", 123)
	ctx.Set("token_id", token.Id)
	ctx.Set("token_key", token.Key)
	GetTokenBilling(ctx)
	assert.Equal(t, 403, rec.Code)
}

func TestTokenBillingUnlimitedAndDisplay(t *testing.T) {
	engine, _, token := setupBillingEndpoint(t)
	require.NoError(t, model.DB.Model(token).Updates(map[string]any{"unlimited_quota": true, "remain_quota": -1, "status": common.TokenStatusExhausted}).Error)
	for _, display := range []string{"USD", "TOKENS", "CUSTOM"} {
		operation_setting.GetGeneralSetting().QuotaDisplayType = display
		result := requestBilling(t, engine, "", "Bearer sk-billingfixture", 200)
		assert.Nil(t, result.Data.Token.Remaining)
		assert.True(t, result.Data.Token.Unlimited)
		assert.Equal(t, 7000000, result.Data.Account.Remaining)
		assert.Equal(t, 1.0, result.Data.Display.Rate)
		if display == "CUSTOM" {
			assert.Equal(t, "USD", result.Data.Display.Type)
		} else {
			assert.Equal(t, display, result.Data.Display.Type)
		}
		assert.Nil(t, result.Data.Pricing.Model)
		require.NotNil(t, result.Data.Pricing.Reason)
		assert.Equal(t, "model_not_requested", *result.Data.Pricing.Reason)
	}
}

func TestTokenBillingMalformedModel(t *testing.T) {
	engine, _, _ := setupBillingEndpoint(t)
	for _, query := range []string{"?model=", "?model=a&model=b", "?model=a%00b", "?model=a+b", "?model=%ff", "?model=%ZZ", "?model=" + strings.Repeat("x", 256)} {
		result := requestBilling(t, engine, query, "Bearer sk-billingfixture", 400)
		assert.False(t, result.Success)
		assert.Equal(t, "invalid_model", result.Code)
	}
}

func TestTokenBillingUnsafeMetadata(t *testing.T) {
	engine, user, _ := setupBillingEndpoint(t)
	for _, unit := range []float64{0, -1, math.NaN(), math.Inf(1), 9007199254740992} {
		common.QuotaPerUnit = unit
		result := requestBilling(t, engine, "", "Bearer sk-billingfixture", 503)
		assert.False(t, result.Success)
	}
	common.QuotaPerUnit = 1
	operation_setting.USDExchangeRate = 0
	requestBilling(t, engine, "", "Bearer sk-billingfixture", 503)
	operation_setting.USDExchangeRate = 1
	require.NoError(t, model.DB.Model(user).Update("quota", -1).Error)
	requestBilling(t, engine, "", "Bearer sk-billingfixture", 503)
}
