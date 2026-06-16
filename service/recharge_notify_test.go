package service

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"

	"github.com/stretchr/testify/require"
)

// disableSSRFForBarkTest 临时关闭 SSRF 防护，使本地 httptest.Server 可被 sendBarkRequest 访问，
// 并确保 httpClient 已初始化。
func disableSSRFForBarkTest(t *testing.T) {
	t.Helper()
	InitHttpClient()
	fs := system_setting.GetFetchSetting()
	original := fs.EnableSSRFProtection
	fs.EnableSSRFProtection = false
	t.Cleanup(func() {
		fs.EnableSSRFProtection = original
	})
}

// barkRecorder 记录 Bark 端点收到的请求 URL。
type barkRecorder struct {
	mu  sync.Mutex
	url string
}

func (r *barkRecorder) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		r.mu.Lock()
		r.url = req.URL.String()
		r.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}
}

func (r *barkRecorder) capturedURL() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.url
}

func resetRechargeNotifySettings(t *testing.T) {
	t.Helper()
	originalEnabled := operation_setting.RechargeNotifyEnabled
	originalBarkUrl := operation_setting.RechargeNotifyBarkUrl
	originalLinkBase := operation_setting.RechargeNotifyLinkBase
	originalServerAddress := system_setting.ServerAddress
	originalCustomCallback := operation_setting.CustomCallbackAddress
	t.Cleanup(func() {
		operation_setting.RechargeNotifyEnabled = originalEnabled
		operation_setting.RechargeNotifyBarkUrl = originalBarkUrl
		operation_setting.RechargeNotifyLinkBase = originalLinkBase
		system_setting.ServerAddress = originalServerAddress
		operation_setting.CustomCallbackAddress = originalCustomCallback
	})
}

func TestNotifyRechargePendingReturnsFalseWhenDisabled(t *testing.T) {
	resetRechargeNotifySettings(t)

	operation_setting.RechargeNotifyEnabled = false
	operation_setting.RechargeNotifyBarkUrl = "https://api.day.app/key/{{title}}/{{content}}"
	require.False(t, NotifyRechargePending(1, "TRADE1", "微信人工充值", 50, 50))
}

func TestNotifyRechargePendingReturnsFalseWhenBarkUrlEmpty(t *testing.T) {
	resetRechargeNotifySettings(t)

	operation_setting.RechargeNotifyEnabled = true
	operation_setting.RechargeNotifyBarkUrl = ""
	require.False(t, NotifyRechargePending(1, "TRADE1", "微信人工充值", 50, 50))
}

func TestNotifyRechargePendingSendsDeepLinkAndContent(t *testing.T) {
	resetRechargeNotifySettings(t)
	disableSSRFForBarkTest(t)

	rec := &barkRecorder{}
	server := httptest.NewServer(rec.handler())
	defer server.Close()

	operation_setting.RechargeNotifyEnabled = true
	operation_setting.RechargeNotifyBarkUrl = server.URL + "/devicekey/{{title}}/{{content}}"
	operation_setting.RechargeNotifyLinkBase = "https://model.codingrui.work"

	sent := NotifyRechargePending(42, "MANUSR42NOabc", "微信人工充值", 50, 50)
	require.True(t, sent)

	captured := rec.capturedURL()
	// 标题/正文已替换并 escape
	require.Contains(t, captured, url.QueryEscape("新的人工充值待确认"))
	require.Contains(t, captured, url.QueryEscape("微信人工充值"))
	// 深链通过 url= 参数透传
	expectedDeepLink := "https://model.codingrui.work/recharge-review?trade_no=" + url.QueryEscape("MANUSR42NOabc")
	require.Contains(t, captured, "url="+url.QueryEscape(expectedDeepLink))
}

func TestNotifyRechargePendingFallsBackToCallbackAddress(t *testing.T) {
	resetRechargeNotifySettings(t)
	disableSSRFForBarkTest(t)

	rec := &barkRecorder{}
	server := httptest.NewServer(rec.handler())
	defer server.Close()

	operation_setting.RechargeNotifyEnabled = true
	operation_setting.RechargeNotifyBarkUrl = server.URL + "/devicekey/{{title}}/{{content}}"
	operation_setting.RechargeNotifyLinkBase = ""
	// linkBase 为空 -> 回退 GetCallbackAddress()
	operation_setting.CustomCallbackAddress = ""
	system_setting.ServerAddress = "https://fallback.example.com"

	require.True(t, NotifyRechargePending(7, "TNFALLBACK", "支付宝人工充值", 10, 73))

	captured := rec.capturedURL()
	expectedDeepLink := "https://fallback.example.com/recharge-review?trade_no=" + url.QueryEscape("TNFALLBACK")
	require.Contains(t, captured, "url="+url.QueryEscape(expectedDeepLink))
}

func TestNotifyRechargePendingReturnsFalseWhenSendFails(t *testing.T) {
	resetRechargeNotifySettings(t)
	disableSSRFForBarkTest(t)

	// Bark 端点返回 500，使 sendBarkRequest 返回错误，从而触发回退。
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	operation_setting.RechargeNotifyEnabled = true
	operation_setting.RechargeNotifyBarkUrl = server.URL + "/devicekey/{{title}}/{{content}}"
	operation_setting.RechargeNotifyLinkBase = "https://model.codingrui.work"

	// 发送失败必须返回 false，调用方据此回退到旧通知方式。
	require.False(t, NotifyRechargePending(42, "TRADEFAIL", "微信人工充值", 50, 50))
}

func TestSendBarkRequestAppendsDeepLinkWithQuerySeparator(t *testing.T) {
	disableSSRFForBarkTest(t)

	rec := &barkRecorder{}
	server := httptest.NewServer(rec.handler())
	defer server.Close()

	notify := dto.NewNotify(dto.NotifyTypeManualTopUp, "T", "C", nil)
	// barkURL 已含 ? -> 应使用 & 追加 url=
	barkURL := server.URL + "/key/{{title}}/{{content}}?group=topup"
	require.NoError(t, sendBarkRequest(barkURL, notify, "https://example.com/page"))

	captured := rec.capturedURL()
	require.Contains(t, captured, "group=topup")
	require.Contains(t, captured, "&url="+url.QueryEscape("https://example.com/page"))
}

func TestSendBarkRequestNoDeepLinkWhenEmpty(t *testing.T) {
	disableSSRFForBarkTest(t)

	rec := &barkRecorder{}
	server := httptest.NewServer(rec.handler())
	defer server.Close()

	notify := dto.NewNotify(dto.NotifyTypeManualTopUp, "T", "C", nil)
	require.NoError(t, sendBarkRequest(server.URL+"/key/{{title}}/{{content}}", notify, ""))

	captured := rec.capturedURL()
	require.NotContains(t, captured, "url=")
}
