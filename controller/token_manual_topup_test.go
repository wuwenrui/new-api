package controller

import (
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const manualTokenPath = "/api/billing/token/manual-topup"

func setupTokenManualTopUp(t *testing.T) (*gin.Engine, *model.User, *model.Token) {
	t.Helper()
	engine, user, token := setupBillingEndpoint(t)
	require.NoError(t, model.DB.AutoMigrate(&model.TopUp{}))
	resetManualTopUpSettingsForTest(t)
	oldPayment := *operation_setting.GetPaymentSetting()
	oldPrice, oldGroups := operation_setting.Price, common.TopupGroupRatio2JSONString()
	t.Cleanup(func() {
		*operation_setting.GetPaymentSetting() = oldPayment
		operation_setting.Price = oldPrice
		require.NoError(t, common.UpdateTopupGroupRatioByJSONString(oldGroups))
	})
	*operation_setting.GetPaymentSetting() = operation_setting.PaymentSetting{
		ComplianceConfirmed: true, ComplianceTermsVersion: operation_setting.CurrentComplianceTermsVersion,
		AmountOptions: []int{1, 2, 10, 20}, AmountDiscount: map[int]float64{10: 0.8},
	}
	operation_setting.ManualTopUpEnabled = true
	operation_setting.ManualTopUpMinTopUp = 2
	operation_setting.ManualTopUpWechatQRCode = "https://example.invalid/wechat.png"
	operation_setting.ManualTopUpAlipayQRCode = ""
	operation_setting.ManualTopUpInstructions = "Include your order number."
	operation_setting.Price = 3
	require.NoError(t, common.UpdateTopupGroupRatioByJSONString(`{"default":1.5,"vip":9}`))
	routes := engine.Group(manualTokenPath, middleware.DisableCache(), middleware.TokenAuthReadOnly(), middleware.TokenManualTopUpAuth())
	routes.GET("/options", GetTokenManualTopUpOptions)
	routes.POST("/quote", QuoteTokenManualTopUp)
	routes.POST("/orders", CreateTokenManualTopUp)
	routes.GET("/orders", GetTokenManualTopUpOrders)
	return engine, user, token
}

func requestTokenManual(t *testing.T, engine *gin.Engine, method, path, body string, status int) map[string]interface{} {
	t.Helper()
	req := httptest.NewRequest(method, manualTokenPath+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer sk-billingfixture")
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "192.0.2.1:1234"
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	require.Equal(t, status, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Header().Get("Cache-Control"), "no-store")
	var result map[string]interface{}
	require.NoError(t, common.Unmarshal(rec.Body.Bytes(), &result))
	if status == http.StatusOK {
		require.Equal(t, true, result["success"], rec.Body.String())
	}
	if status >= 400 {
		assert.Equal(t, false, result["success"], rec.Body.String())
	}
	assert.NotContains(t, rec.Body.String(), "billingfixture")
	return result
}

func TestTokenManualTopUpOptionsAndQuote(t *testing.T) {
	engine, _, _ := setupTokenManualTopUp(t)
	options := requestTokenManual(t, engine, "GET", "/options", "", 200)["data"].(map[string]interface{})
	assert.Equal(t, map[string]interface{}{
		"version": float64(1), "enabled": true, "min_amount": float64(2), "amount_step": float64(1),
		"amount_options": []interface{}{float64(2), float64(10), float64(20)}, "payment_currency": "CNY",
		"methods":      []interface{}{map[string]interface{}{"id": model.PaymentMethodManualWechat, "name": "微信人工充值"}},
		"instructions": "Include your order number.",
	}, options)
	for _, display := range []string{"USD", "CNY"} {
		operation_setting.GetGeneralSetting().QuotaDisplayType = display
		quote := requestTokenManual(t, engine, "POST", "/quote", `{"amount":10,"payment_method":"manual_wechat"}`, 200)["data"]
		assert.Equal(t, map[string]interface{}{"amount": float64(10), "payment_method": "manual_wechat", "money": float64(36), "payment_currency": "CNY", "expected_quota": float64(7000000)}, quote,
			"price 3 × owner-group 1.5 × discount .8, not exchange rate 7.2 or token-group 9")
	}
	var count int64
	require.NoError(t, model.DB.Model(&model.TopUp{}).Count(&count).Error)
	assert.Zero(t, count, "options and quote must never create an order")
	for _, disabled := range []string{"switch", "compliance", "qr"} {
		t.Run(disabled, func(t *testing.T) {
			operation_setting.ManualTopUpEnabled = disabled != "switch"
			operation_setting.GetPaymentSetting().ComplianceConfirmed = disabled != "compliance"
			operation_setting.ManualTopUpWechatQRCode = "https://example.invalid/qr.png"
			if disabled == "qr" {
				operation_setting.ManualTopUpWechatQRCode = ""
			}
			data := requestTokenManual(t, engine, "GET", "/options", "", 200)["data"].(map[string]interface{})
			assert.Equal(t, false, data["enabled"])
			assert.Empty(t, data["methods"])
			requestTokenManual(t, engine, "POST", "/quote", `{"amount":10,"payment_method":"manual_wechat"}`, 400)
		})
	}
}

func TestTokenManualTopUpRejectsStrictInput(t *testing.T) {
	engine, _, _ := setupTokenManualTopUp(t)
	cases := []struct{ name, body string }{
		{"empty", ``}, {"missing", `{"amount":10}`}, {"null", `{"amount":null,"payment_method":"manual_wechat"}`},
		{"unknown", `{"amount":10,"payment_method":"manual_wechat","user_id":999}`},
		{"duplicate", `{"amount":10,"amount":20,"payment_method":"manual_wechat"}`},
		{"trailing", `{"amount":10,"payment_method":"manual_wechat"} {}`},
		{"string", `{"amount":"10","payment_method":"manual_wechat"}`},
		{"fraction", `{"amount":10.5,"payment_method":"manual_wechat"}`},
		{"negative", `{"amount":-2,"payment_method":"manual_wechat"}`},
		{"zero", `{"amount":0,"payment_method":"manual_wechat"}`},
		{"below-minimum", `{"amount":1,"payment_method":"manual_wechat"}`},
		{"huge", `{"amount":9223372036854775807,"payment_method":"manual_wechat"}`},
		{"overflow", `{"amount":18446744073709551616,"payment_method":"manual_wechat"}`},
		{"unsupported-method", `{"amount":10,"payment_method":"stripe"}`},
		{"disabled-method", `{"amount":10,"payment_method":"manual_alipay"}`},
		{"oversized", `{"amount":10,"payment_method":"` + strings.Repeat("x", 1024) + `"}`},
	}
	for _, path := range []string{"/quote", "/orders"} {
		for _, tc := range cases {
			t.Run(path+"/"+tc.name, func(t *testing.T) { requestTokenManual(t, engine, "POST", path, tc.body, 400) })
		}
		requestTokenManual(t, engine, "POST", path+"?user_id=999", `{"amount":10,"payment_method":"manual_wechat"}`, 400)
	}
	requestTokenManual(t, engine, "GET", "/options?group=vip", "", 400)
	var count int64
	require.NoError(t, model.DB.Model(&model.TopUp{}).Count(&count).Error)
	assert.Zero(t, count)
}

func TestTokenManualTopUpTokensAndInvalidSettings(t *testing.T) {
	engine, _, _ := setupTokenManualTopUp(t)
	operation_setting.GetGeneralSetting().QuotaDisplayType = "TOKENS"
	operation_setting.GetPaymentSetting().AmountOptions = []int{10, 1400000, 1400001, 2100000}
	options := requestTokenManual(t, engine, "GET", "/options", "", 200)["data"].(map[string]interface{})
	assert.Equal(t, float64(1400000), options["min_amount"])
	assert.Equal(t, float64(700000), options["amount_step"])
	assert.Equal(t, []interface{}{float64(1400000), float64(2100000)}, options["amount_options"])
	quote := requestTokenManual(t, engine, "POST", "/quote", `{"amount":1400000,"payment_method":"manual_wechat"}`, 200)["data"].(map[string]interface{})
	assert.Equal(t, float64(1400000), quote["expected_quota"])
	assert.Equal(t, float64(9), quote["money"])
	for _, path := range []string{"/quote", "/orders"} {
		requestTokenManual(t, engine, "POST", path, `{"amount":1400001,"payment_method":"manual_wechat"}`, 400) // never truncate fractional stored units
	}
	cases := []struct {
		name  string
		apply func()
	}{
		{"unsupported-display", func() { operation_setting.GetGeneralSetting().QuotaDisplayType = "UNRECOGNIZED" }},
		{"fractional-token-unit", func() { common.QuotaPerUnit = 700000.5 }},
		{"zero-unit", func() { common.QuotaPerUnit = 0 }},
		{"nan-unit", func() { common.QuotaPerUnit = math.NaN() }},
		{"infinite-unit", func() { common.QuotaPerUnit = math.Inf(1) }},
		{"oversized-unit", func() { common.QuotaPerUnit = 1e20 }},
		{"zero-price", func() { operation_setting.Price = 0 }},
		{"negative-price", func() { operation_setting.Price = -1 }},
		{"nan-price", func() { operation_setting.Price = math.NaN() }},
		{"infinite-price", func() { operation_setting.Price = math.Inf(1) }},
		{"huge-minimum", func() { operation_setting.ManualTopUpMinTopUp = math.MaxInt }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			operation_setting.GetGeneralSetting().QuotaDisplayType = "TOKENS"
			common.QuotaPerUnit = 700000
			operation_setting.Price = 3
			operation_setting.ManualTopUpMinTopUp = 2
			tc.apply()
			requestTokenManual(t, engine, "GET", "/options", "", 503)
			for _, path := range []string{"/quote", "/orders"} {
				requestTokenManual(t, engine, "POST", path, `{"amount":1400000,"payment_method":"manual_wechat"}`, 400)
			}
		})
	}
}

func TestTokenManualTopUpRejectsInvalidDiscountAndCapacity(t *testing.T) {
	engine, user, _ := setupTokenManualTopUp(t)
	for _, discount := range []float64{math.NaN(), math.Inf(1)} {
		operation_setting.GetPaymentSetting().AmountDiscount = map[int]float64{10: discount}
		requestTokenManual(t, engine, "POST", "/quote", `{"amount":10,"payment_method":"manual_wechat"}`, 400)
	}
	operation_setting.GetPaymentSetting().AmountDiscount = map[int]float64{}
	require.NoError(t, common.UpdateTopupGroupRatioByJSONString(`{"default":-1}`))
	requestTokenManual(t, engine, "POST", "/quote", `{"amount":10,"payment_method":"manual_wechat"}`, 400)
	require.NoError(t, common.UpdateTopupGroupRatioByJSONString(`{"default":1}`))
	require.NoError(t, model.DB.Model(user).Update("quota", common.MaxWalletQuota).Error)
	for _, path := range []string{"/quote", "/orders"} {
		requestTokenManual(t, engine, "POST", path, `{"amount":10,"payment_method":"manual_wechat"}`, 400)
	}
}

func TestTokenManualTopUpCreatePendingAndBark(t *testing.T) {
	for _, entry := range []string{"facade", "website", "tokens"} {
		t.Run(entry, func(t *testing.T) {
			engine, user, token := setupTokenManualTopUp(t)
			requestAmount := "10"
			if entry == "tokens" {
				operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeTokens
				operation_setting.GetPaymentSetting().AmountDiscount = map[int]float64{7000000: 0.8}
				requestAmount = "7000000"
			}
			require.NoError(t, model.DB.AutoMigrate(&model.Log{}))
			oldLogDB := model.LOG_DB
			model.LOG_DB = model.DB
			t.Cleanup(func() { model.LOG_DB = oldLogDB })
			// Exhausted credentials may request replenishment, without reviving token quota.
			require.NoError(t, model.DB.Model(token).Updates(map[string]interface{}{"status": common.TokenStatusExhausted, "remain_quota": 0}).Error)
			var beforeToken model.Token
			require.NoError(t, model.DB.First(&beforeToken, token.Id).Error)
			var beforeUser model.User
			require.NoError(t, model.DB.First(&beforeUser, user.Id).Error)
			oldEnabled, oldBark, oldLink := operation_setting.RechargeNotifyEnabled, operation_setting.RechargeNotifyBarkUrl, operation_setting.RechargeNotifyLinkBase
			oldServer, oldCallback := system_setting.ServerAddress, operation_setting.CustomCallbackAddress
			oldWorker, oldWorkerKey := system_setting.WorkerUrl, system_setting.WorkerValidKey
			oldFetch := *system_setting.GetFetchSetting()
			t.Cleanup(func() {
				operation_setting.RechargeNotifyEnabled, operation_setting.RechargeNotifyBarkUrl, operation_setting.RechargeNotifyLinkBase = oldEnabled, oldBark, oldLink
				system_setting.ServerAddress, operation_setting.CustomCallbackAddress = oldServer, oldCallback
				system_setting.WorkerUrl, system_setting.WorkerValidKey = oldWorker, oldWorkerKey
				*system_setting.GetFetchSetting() = oldFetch
			})
			service.InitHttpClient()
			system_setting.GetFetchSetting().EnableSSRFProtection = false
			system_setting.WorkerUrl, system_setting.WorkerValidKey = "", ""
			system_setting.ServerAddress, operation_setting.CustomCallbackAddress = "https://example.invalid", ""
			var calls atomic.Int32
			received := make(chan *url.URL, 4)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(http.StatusOK)
				w.(http.Flusher).Flush()
				received <- r.URL
			}))
			defer server.Close()
			operation_setting.RechargeNotifyEnabled = true
			operation_setting.RechargeNotifyBarkUrl = server.URL + "/device/{{title}}/{{content}}"
			operation_setting.RechargeNotifyLinkBase = "https://example.invalid"
			var data map[string]interface{}
			if entry != "website" {
				data = requestTokenManual(t, engine, "POST", "/orders", `{"amount":`+requestAmount+`,"payment_method":"manual_wechat"}`, 200)["data"].(map[string]interface{})
			} else {
				// Website authentication is session-based; supply its authenticated identity
				// here while exercising the unchanged website request/response handler.
				engine.POST("/website-manual", func(c *gin.Context) { c.Set("id", user.Id) }, RequestManualTopUp)
				for _, body := range []string{`{"amount":9223372036854775807,"payment_method":"manual_wechat"}`, `{"amount":10,"payment_method":"manual_wechat"}`} {
					rec := httptest.NewRecorder()
					req := httptest.NewRequest("POST", "/website-manual", strings.NewReader(body))
					req.Header.Set("Content-Type", "application/json")
					engine.ServeHTTP(rec, req)
					require.Equal(t, 200, rec.Code)
					var result map[string]interface{}
					require.NoError(t, common.Unmarshal(rec.Body.Bytes(), &result))
					if strings.Contains(body, "922337") {
						assert.Equal(t, "error", result["message"])
					} else {
						require.Equal(t, "success", result["message"])
						data = result["data"].(map[string]interface{})
					}
				}
			}
			tradeNo := data["trade_no"].(string)
			require.NotEmpty(t, tradeNo)
			select {
			case notification := <-received:
				assert.Equal(t, "https://example.invalid/recharge-review?trade_no="+url.QueryEscape(tradeNo), notification.Query().Get("url"))
				decoded, err := url.QueryUnescape(notification.Path)
				require.NoError(t, err)
				assert.Contains(t, decoded, "新的人工充值待确认")
				assert.Contains(t, decoded, "应收金额: ¥36.00")
			case <-time.After(5 * time.Second):
				t.Fatal("local Bark request was not received")
			}
			assert.Equal(t, int32(1), calls.Load())
			assert.Equal(t, float64(36), data["money"])
			assert.Equal(t, "https://example.invalid/wechat.png", data["qr_url"])
			var orders []model.TopUp
			require.NoError(t, model.DB.Find(&orders).Error)
			require.Len(t, orders, 1)
			assert.Equal(t, user.Id, orders[0].UserId)
			assert.Equal(t, tradeNo, orders[0].TradeNo)
			assert.Equal(t, int64(10), orders[0].Amount)
			assert.Equal(t, float64(36), orders[0].Money)
			assert.Equal(t, model.PaymentProviderManualTopUp, orders[0].PaymentProvider)
			assert.Equal(t, common.TopUpStatusPending, orders[0].Status)
			var afterUser model.User
			var afterToken model.Token
			require.NoError(t, model.DB.First(&afterUser, user.Id).Error)
			require.NoError(t, model.DB.First(&afterToken, token.Id).Error)
			assert.Equal(t, beforeUser, afterUser, "creating an order must not change the wallet")
			assert.Equal(t, beforeToken, afterToken, "creating an order must not change the exhausted token")
			// Reuse the real admin handlers on the newly-created order; admin route
			// authentication is covered separately, so this fixture supplies no fake role.
			expectedWallet := beforeUser.Quota
			handler := ConfirmManualTopUpStatus
			body := `{"trade_nos":["` + tradeNo + `"]}`
			if entry != "website" {
				handler = AdminCompleteTopUp
				body = `{"trade_no":"` + tradeNo + `","amount":10}`
				expectedWallet += 7000000
			}
			for attempt := 0; attempt < 2; attempt++ {
				rec := httptest.NewRecorder()
				ctx, _ := gin.CreateTestContext(rec)
				ctx.Request = httptest.NewRequest("POST", "/admin-complete", strings.NewReader(body))
				ctx.Request.Header.Set("Content-Type", "application/json")
				handler(ctx)
				require.Equal(t, 200, rec.Code)
				var result map[string]interface{}
				require.NoError(t, common.Unmarshal(rec.Body.Bytes(), &result))
				require.Equal(t, true, result["success"], rec.Body.String())
				require.NoError(t, model.DB.First(&afterUser, user.Id).Error)
				assert.Equal(t, expectedWallet, afterUser.Quota, "repeat completion cannot credit twice; status-only never credits")
			}
			require.NoError(t, model.DB.First(&afterToken, token.Id).Error)
			assert.Equal(t, beforeToken, afterToken)
			require.NoError(t, model.DB.First(&orders[0], orders[0].Id).Error)
			assert.Equal(t, common.TopUpStatusSuccess, orders[0].Status)
			assert.Equal(t, int32(1), calls.Load())
		})
	}
}

func TestTokenManualTopUpHistoryIsolation(t *testing.T) {
	engine, user, _ := setupTokenManualTopUp(t)
	now := common.GetTimestamp()
	for _, order := range []model.TopUp{
		{UserId: user.Id, TradeNo: "own-manual", Money: 36, Amount: 10, PaymentMethod: model.PaymentMethodManualWechat, PaymentProvider: model.PaymentProviderManualTopUp, Status: common.TopUpStatusPending, CreateTime: now},
		{UserId: user.Id + 1, TradeNo: "foreign-manual", PaymentProvider: model.PaymentProviderManualTopUp, CreateTime: now},
		{UserId: user.Id, TradeNo: "own-online", PaymentProvider: "stripe", CreateTime: now},
		{UserId: user.Id, TradeNo: "own-old", PaymentProvider: model.PaymentProviderManualTopUp, CreateTime: now - 31*24*3600},
	} {
		require.NoError(t, model.DB.Create(&order).Error)
	}
	data := requestTokenManual(t, engine, "GET", "/orders?p=1&page_size=1", "", 200)["data"].(map[string]interface{})
	assert.Equal(t, float64(1), data["total"])
	assert.Equal(t, []interface{}{map[string]interface{}{
		"trade_no": "own-manual", "money": float64(36), "payment_method": model.PaymentMethodManualWechat,
		"status": common.TopUpStatusPending, "create_time": float64(now), "complete_time": float64(0),
	}}, data["items"])
	for _, query := range []string{"?user_id=999", "?status=pending", "?p=0", "?p=1&p=2", "?page_size=101", "?page_size=1.5"} {
		requestTokenManual(t, engine, "GET", "/orders"+query, "", 400)
	}
}

func TestTokenManualTopUpAuthRejectsExpiredIPAndOwner(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		change func(*model.User, *model.Token)
	}{
		{"expired", 401, func(_ *model.User, token *model.Token) {
			require.NoError(t, model.DB.Model(token).Update("expired_time", common.GetTimestamp()-1).Error)
		}},
		{"IP", 403, func(_ *model.User, token *model.Token) {
			require.NoError(t, model.DB.Model(token).Update("allow_ips", "203.0.113.0/24").Error)
		}},
		{"disabled-owner", 403, func(user *model.User, _ *model.Token) {
			require.NoError(t, model.DB.Model(user).Update("status", common.UserStatusDisabled).Error)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			engine, user, token := setupTokenManualTopUp(t)
			tc.change(user, token)
			requestTokenManual(t, engine, "POST", "/orders", `{"amount":10,"payment_method":"manual_wechat"}`, tc.status)
			var count int64
			require.NoError(t, model.DB.Model(&model.TopUp{}).Count(&count).Error)
			assert.Zero(t, count)
		})
	}
}
