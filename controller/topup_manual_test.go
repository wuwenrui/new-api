package controller

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func resetManualTopUpSettingsForTest(t *testing.T) {
	t.Helper()

	originalEnabled := operation_setting.ManualTopUpEnabled
	originalMinTopUp := operation_setting.ManualTopUpMinTopUp
	originalWechatQRCode := operation_setting.ManualTopUpWechatQRCode
	originalAlipayQRCode := operation_setting.ManualTopUpAlipayQRCode
	originalInstructions := operation_setting.ManualTopUpInstructions
	originalQuotaDisplayType := operation_setting.GetGeneralSetting().QuotaDisplayType
	t.Cleanup(func() {
		operation_setting.ManualTopUpEnabled = originalEnabled
		operation_setting.ManualTopUpMinTopUp = originalMinTopUp
		operation_setting.ManualTopUpWechatQRCode = originalWechatQRCode
		operation_setting.ManualTopUpAlipayQRCode = originalAlipayQRCode
		operation_setting.ManualTopUpInstructions = originalInstructions
		operation_setting.GetGeneralSetting().QuotaDisplayType = originalQuotaDisplayType
	})
}

func TestGetManualTopUpMethodsRequiresEnabledAndQRCode(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	resetManualTopUpSettingsForTest(t)

	operation_setting.ManualTopUpEnabled = false
	operation_setting.ManualTopUpWechatQRCode = "https://example.com/wechat.png"
	operation_setting.ManualTopUpAlipayQRCode = "https://example.com/alipay.png"
	require.False(t, isManualTopUpEnabled())
	require.Empty(t, getManualTopUpMethods())

	operation_setting.ManualTopUpEnabled = true
	operation_setting.ManualTopUpWechatQRCode = ""
	operation_setting.ManualTopUpAlipayQRCode = "https://example.com/alipay.png"
	methods := getManualTopUpMethods()
	require.True(t, isManualTopUpEnabled())
	require.Len(t, methods, 1)
	require.Equal(t, model.PaymentMethodManualAlipay, methods[0]["type"])
}

func TestGetManualTopUpMethodReturnsConfiguredQRCode(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	resetManualTopUpSettingsForTest(t)

	operation_setting.ManualTopUpEnabled = true
	operation_setting.ManualTopUpWechatQRCode = "https://example.com/wechat.png"
	operation_setting.ManualTopUpAlipayQRCode = "https://example.com/alipay.png"

	method, ok := getManualTopUpMethod(model.PaymentMethodManualWechat)
	require.True(t, ok)
	require.Equal(t, "微信人工充值", method.Name)
	require.Equal(t, "https://example.com/wechat.png", method.QRCode)

	_, ok = getManualTopUpMethod("wechat")
	require.False(t, ok)
}

func TestGetManualTopUpMinTopupUsesDisplayType(t *testing.T) {
	resetManualTopUpSettingsForTest(t)

	operation_setting.ManualTopUpMinTopUp = 2
	operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeUSD
	require.Equal(t, int64(2), getManualTopupMinTopup())

	operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeTokens
	require.Equal(t, int64(2*common.QuotaPerUnit), getManualTopupMinTopup())
}

func TestBuildManualTopUpNotificationContent(t *testing.T) {
	notification := buildManualTopUpNotification(manualTopUpNotificationInput{
		UserID:        8,
		TradeNo:       "MANUSR8NOabc",
		PaymentName:   "微信人工充值",
		DisplayAmount: 100,
		PayMoney:      200,
	})

	require.Equal(t, "新的人工充值待确认", notification.Subject)
	require.Contains(t, notification.Content, "用户ID: 8")
	require.Contains(t, notification.Content, "订单号: MANUSR8NOabc")
	require.Contains(t, notification.Content, "收款方式: 微信人工充值")
	require.Contains(t, notification.Content, "应收金额: ¥200.00")
}

func TestGetTopUpInfoHidesEpayMethodsWhenGatewayIsNotConfigured(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	resetManualTopUpSettingsForTest(t)

	originalPayAddress := operation_setting.PayAddress
	originalEpayID := operation_setting.EpayId
	originalEpayKey := operation_setting.EpayKey
	originalPayMethods := operation_setting.PayMethods
	t.Cleanup(func() {
		operation_setting.PayAddress = originalPayAddress
		operation_setting.EpayId = originalEpayID
		operation_setting.EpayKey = originalEpayKey
		operation_setting.PayMethods = originalPayMethods
	})

	operation_setting.PayAddress = ""
	operation_setting.EpayId = ""
	operation_setting.EpayKey = ""
	operation_setting.PayMethods = []map[string]string{
		{"name": "支付宝", "type": "alipay"},
		{"name": "微信", "type": "wxpay"},
	}
	operation_setting.ManualTopUpEnabled = true
	operation_setting.ManualTopUpWechatQRCode = "https://example.com/wechat.png"
	operation_setting.ManualTopUpAlipayQRCode = "https://example.com/alipay.png"

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/user/topup/info", nil)

	GetTopUpInfo(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Success bool `json:"success"`
		Data    struct {
			EnableOnlineTopup bool                `json:"enable_online_topup"`
			PayMethods        []map[string]string `json:"pay_methods"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	require.True(t, response.Success)
	require.False(t, response.Data.EnableOnlineTopup)
	require.Equal(t, []map[string]string{
		{
			"color":     "rgba(var(--semi-green-5), 1)",
			"min_topup": "1",
			"name":      "微信人工充值",
			"type":      model.PaymentMethodManualWechat,
		},
		{
			"color":     "rgba(var(--semi-blue-5), 1)",
			"min_topup": "1",
			"name":      "支付宝人工充值",
			"type":      model.PaymentMethodManualAlipay,
		},
	}, response.Data.PayMethods)
}
