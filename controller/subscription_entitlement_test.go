package controller

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupSubscriptionEntitlementControllerTestDB(t *testing.T) {
	t.Helper()
	originalDB := model.DB
	originalLogDB := model.LOG_DB
	originalRedisEnabled := common.RedisEnabled
	originalBatchUpdate := common.BatchUpdateEnabled
	originalRechargeNotifyEnabled := operation_setting.RechargeNotifyEnabled

	common.RedisEnabled = false
	common.BatchUpdateEnabled = false
	operation_setting.RechargeNotifyEnabled = false
	gin.SetMode(gin.TestMode)

	dbPath := filepath.Join(t.TempDir(), "subscription-entitlement-controller.db")
	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(
		&model.User{},
		&model.Log{},
		&model.TopUp{},
		&model.SubscriptionPlan{},
		&model.SubscriptionOrder{},
		&model.UserSubscription{},
	))
	model.DB = db
	model.LOG_DB = db

	t.Cleanup(func() {
		model.DB = originalDB
		model.LOG_DB = originalLogDB
		common.RedisEnabled = originalRedisEnabled
		common.BatchUpdateEnabled = originalBatchUpdate
		operation_setting.RechargeNotifyEnabled = originalRechargeNotifyEnabled
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
	})
}

func seedSubscriptionEntitlementUserAndPlan(t *testing.T) (*model.User, *model.SubscriptionPlan) {
	t.Helper()
	user := &model.User{
		Username: "wechat_user",
		Email:    "wechat@example.com",
		Group:    "default",
		Status:   common.UserStatusEnabled,
	}
	require.NoError(t, model.DB.Create(user).Error)
	plan := &model.SubscriptionPlan{
		Title:         "微信高级功能",
		PriceAmount:   19.9,
		Currency:      "USD",
		DurationUnit:  model.SubscriptionDurationMonth,
		DurationValue: 1,
		Enabled:       true,
		FeatureKeys:   model.SubscriptionFeatureWechatBridge,
	}
	require.NoError(t, model.DB.Create(plan).Error)
	return user, plan
}

func TestGetEntitlementsSelfReturnsWechatBridgeFeature(t *testing.T) {
	setupSubscriptionEntitlementControllerTestDB(t)
	user, plan := seedSubscriptionEntitlementUserAndPlan(t)
	now := common.GetTimestamp()
	require.NoError(t, model.DB.Create(&model.UserSubscription{
		UserId:    user.Id,
		PlanId:    plan.Id,
		StartTime: now - 60,
		EndTime:   now + 3600,
		Status:    "active",
		Source:    "test",
	}).Error)

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Set("id", user.Id)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/entitlements/self", nil)

	GetEntitlementsSelf(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Success bool `json:"success"`
		Data    struct {
			Features map[string]bool `json:"features"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	require.True(t, response.Success)
	require.True(t, response.Data.Features[model.SubscriptionFeatureWechatBridge])
}

func setSubscriptionFeaturePoliciesForTest(t *testing.T, policies map[string]string) {
	t.Helper()
	setting := operation_setting.GetSubscriptionFeatureSetting()
	original := setting.AccessPolicies
	setting.AccessPolicies = policies
	t.Cleanup(func() {
		setting.AccessPolicies = original
	})
}

func fetchEntitlementFeatures(t *testing.T, userId int) map[string]bool {
	t.Helper()
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Set("id", userId)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/entitlements/self", nil)

	GetEntitlementsSelf(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Success bool `json:"success"`
		Data    struct {
			Features map[string]bool `json:"features"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	require.True(t, response.Success)
	return response.Data.Features
}

func TestGetEntitlementsSelfIncludesAllFeatureKeysWithoutSubscription(t *testing.T) {
	setupSubscriptionEntitlementControllerTestDB(t)
	user, _ := seedSubscriptionEntitlementUserAndPlan(t)
	setSubscriptionFeaturePoliciesForTest(t, map[string]string{})

	features := fetchEntitlementFeatures(t, user.Id)
	for _, featureKey := range model.SubscriptionFeatureKeys {
		require.Contains(t, features, featureKey)
		require.False(t, features[featureKey])
	}
}

func TestGetEntitlementsSelfHonorsFreeAccessPolicy(t *testing.T) {
	setupSubscriptionEntitlementControllerTestDB(t)
	user, _ := seedSubscriptionEntitlementUserAndPlan(t)
	setSubscriptionFeaturePoliciesForTest(t, map[string]string{
		model.SubscriptionFeatureRoundtable: operation_setting.SubscriptionFeaturePolicyFree,
	})

	features := fetchEntitlementFeatures(t, user.Id)
	require.True(t, features[model.SubscriptionFeatureRoundtable])
	require.False(t, features[model.SubscriptionFeatureWechatBridge])
}

func TestRequestWechatBridgeManualSubscriptionCreatesPendingOrder(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	resetManualTopUpSettingsForTest(t)
	setupSubscriptionEntitlementControllerTestDB(t)
	user, plan := seedSubscriptionEntitlementUserAndPlan(t)
	operation_setting.ManualTopUpEnabled = true
	operation_setting.ManualTopUpWechatQRCode = "https://example.com/wechat.png"

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Set("id", user.Id)
	ctx.Request = httptest.NewRequest(
		http.MethodPost,
		"/api/entitlements/wechat-bridge/manual-pay",
		bytes.NewBufferString(`{"plan_id":`+strconv.Itoa(plan.Id)+`,"payment_method":"manual_wechat"}`),
	)
	ctx.Request.Header.Set("Content-Type", "application/json")

	RequestWechatBridgeManualSubscription(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Success bool `json:"success"`
		Data    struct {
			TradeNo string `json:"trade_no"`
			QRURL   string `json:"qr_url"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	require.True(t, response.Success)
	require.NotEmpty(t, response.Data.TradeNo)
	require.Equal(t, "https://example.com/wechat.png", response.Data.QRURL)

	order := model.GetSubscriptionOrderByTradeNo(response.Data.TradeNo)
	require.NotNil(t, order)
	require.Equal(t, model.PaymentProviderManualSubscription, order.PaymentProvider)
	require.Equal(t, common.TopUpStatusPending, order.Status)
}

func TestAdminCompleteManualSubscriptionActivatesEntitlement(t *testing.T) {
	setupSubscriptionEntitlementControllerTestDB(t)
	user, plan := seedSubscriptionEntitlementUserAndPlan(t)
	tradeNo := "SUBMAN-CONTROLLER"
	require.NoError(t, (&model.SubscriptionOrder{
		UserId:          user.Id,
		PlanId:          plan.Id,
		Money:           plan.PriceAmount,
		TradeNo:         tradeNo,
		PaymentMethod:   model.PaymentMethodManualWechat,
		PaymentProvider: model.PaymentProviderManualSubscription,
		Status:          common.TopUpStatusPending,
		CreateTime:      time.Now().Unix(),
	}).Insert())

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(
		http.MethodPost,
		"/api/subscription/admin/manual/complete",
		bytes.NewBufferString(`{"trade_no":"`+tradeNo+`"}`),
	)
	ctx.Request.Header.Set("Content-Type", "application/json")

	AdminCompleteManualSubscription(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Success bool `json:"success"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	require.True(t, response.Success)

	has, err := model.HasActiveUserSubscriptionFeature(user.Id, model.SubscriptionFeatureWechatBridge)
	require.NoError(t, err)
	require.True(t, has)
}
