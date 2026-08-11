package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupPACBalanceTestDB(t *testing.T) {
	t.Helper()
	originalDB := model.DB

	dbPath := filepath.Join(t.TempDir(), "pac-balance-refresh.db")
	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.Channel{}))
	model.DB = db

	t.Cleanup(func() {
		model.DB = originalDB
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
	})
}

func seedPACBalanceChannel(t *testing.T, id int, name string, baseURL string) {
	t.Helper()
	autoBan := 1
	priority := int64(0)
	weight := uint(0)
	require.NoError(t, model.DB.Create(&model.Channel{
		Id:                 id,
		Type:               14,
		Key:                "redacted",
		Status:             1,
		Name:               name,
		Weight:             &weight,
		Models:             "m-x",
		Group:              "default",
		Priority:           &priority,
		AutoBan:            &autoBan,
		BaseURL:            &baseURL,
		CreatedTime:        100,
	}).Error)
}

func setPACProbeConfigs(t *testing.T, raw string) {
	t.Helper()
	common.OptionMapRWMutex.Lock()
	if common.OptionMap == nil {
		common.OptionMap = make(map[string]string)
	}
	common.OptionMap[UpstreamProbeConfigsOptionKey] = raw
	common.OptionMapRWMutex.Unlock()
	t.Cleanup(func() {
		common.OptionMapRWMutex.Lock()
		common.OptionMap[UpstreamProbeConfigsOptionKey] = ""
		common.OptionMapRWMutex.Unlock()
	})
}

func TestRefreshPACChannelBalancesUpdatesPACChannels(t *testing.T) {
	setupPACBalanceTestDB(t)
	seedPACBalanceChannel(t, 9, "pac-bai", "https://cf.api.fan")
	seedPACBalanceChannel(t, 15, "pac-mimo0.8", "https://www.packyapi.com")
	seedPACBalanceChannel(t, 16, "pac-hunyuan", "https://cf.api.fan")
	seedPACBalanceChannel(t, 45, "pac-claude-sale", "https://slb-v1.api.fan")
	seedPACBalanceChannel(t, 1, "ds-official", "https://api.openai.com") // 非 PAC，不应被更新

	// 本地 httptest 模拟 packyapi；host 匹配函数注入为恒真以命中该配置
	originalMatch := pacBalanceUpstreamHostMatch
	pacBalanceUpstreamHostMatch = func(string) bool { return true }
	t.Cleanup(func() { pacBalanceUpstreamHostMatch = originalMatch })

	// 模拟 packyapi /api/user/self 返回 quota = 25697460 -> $51.39492
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/user/self", r.URL.Path)
		assert.Equal(t, "Bearer sys-token", r.Header.Get("Authorization"))
		assert.Equal(t, "5359", r.Header.Get("New-Api-User"))
		assert.NotEmpty(t, r.Header.Get("User-Agent"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"message":"","data":{"quota":25697460}}`))
	}))
	defer srv.Close()

	setPACProbeConfigs(t, `[{"base_url":"`+srv.URL+`","access_token":"sys-token","user_id":"5359"}]`)

	require.NoError(t, RefreshPACChannelBalances(context.Background()))

	for _, id := range []int{9, 15, 16, 45} {
		var ch model.Channel
		require.NoError(t, model.DB.First(&ch, id).Error)
		assert.InDelta(t, 25697460.0/common.QuotaPerUnit, ch.Balance, 1e-6)
		assert.Greater(t, ch.BalanceUpdatedTime, int64(0), "balance_updated_time 应被刷新")
	}

	// 非 PAC 渠道不受影响
	var other model.Channel
	require.NoError(t, model.DB.First(&other, 1).Error)
	assert.Zero(t, other.Balance)
	assert.Zero(t, other.BalanceUpdatedTime)
}

func TestRefreshPACChannelBalancesSkipsWhenNoPackyConfig(t *testing.T) {
	setupPACBalanceTestDB(t)
	seedPACBalanceChannel(t, 9, "pac-bai", "https://cf.api.fan")

	// 只有 coderelay 条目（无 packyapi）或空配置 -> 静默跳过
	setPACProbeConfigs(t, `[{"base_url":"https://cdn.coderelay.cn","access_token":"t","user_id":""}]`)
	require.NoError(t, RefreshPACChannelBalances(context.Background()))

	setPACProbeConfigs(t, "[]")
	require.NoError(t, RefreshPACChannelBalances(context.Background()))

	var ch model.Channel
	require.NoError(t, model.DB.First(&ch, 9).Error)
	assert.Zero(t, ch.Balance)
	assert.Zero(t, ch.BalanceUpdatedTime)
}

func TestRefreshPACChannelBalancesReturnsErrorOnUpstreamFailure(t *testing.T) {
	setupPACBalanceTestDB(t)
	seedPACBalanceChannel(t, 9, "pac-bai", "https://cf.api.fan")

	originalMatch := pacBalanceUpstreamHostMatch
	pacBalanceUpstreamHostMatch = func(string) bool { return true }
	t.Cleanup(func() { pacBalanceUpstreamHostMatch = originalMatch })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	setPACProbeConfigs(t, `[{"base_url":"`+srv.URL+`","access_token":"sys-token","user_id":"5359"}]`)
	err := RefreshPACChannelBalances(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "查询 packyapi 账户余额失败")
}

func TestRefreshPACChannelBalancesRejectsUnsuccessfulResponse(t *testing.T) {
	setupPACBalanceTestDB(t)
	seedPACBalanceChannel(t, 9, "pac-bai", "https://cf.api.fan")

	originalMatch := pacBalanceUpstreamHostMatch
	pacBalanceUpstreamHostMatch = func(string) bool { return true }
	t.Cleanup(func() { pacBalanceUpstreamHostMatch = originalMatch })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":false,"message":"access token 无效","data":null}`))
	}))
	defer srv.Close()

	setPACProbeConfigs(t, `[{"base_url":"`+srv.URL+`","access_token":"bad","user_id":"5359"}]`)
	err := RefreshPACChannelBalances(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "上游拒绝请求")
}

// --- Bark 告警通知 ---

type barkURLRecorder struct {
	mu  sync.Mutex
	url string
}

func (r *barkURLRecorder) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		r.mu.Lock()
		r.url = req.URL.String()
		r.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}
}

func (r *barkURLRecorder) capturedURL() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.url
}

func resetBarkNotifySettings(t *testing.T) {
	t.Helper()
	original := operation_setting.RechargeNotifyBarkUrl
	t.Cleanup(func() {
		operation_setting.RechargeNotifyBarkUrl = original
	})
}

func TestNotifyChannelLowBalanceViaBarkSendsNotification(t *testing.T) {
	resetBarkNotifySettings(t)
	disableSSRFForBarkTest(t)

	rec := &barkURLRecorder{}
	server := httptest.NewServer(rec.handler())
	defer server.Close()

	operation_setting.RechargeNotifyBarkUrl = server.URL + "/devicekey/{{title}}/{{content}}"

	NotifyChannelLowBalanceViaBark("渠道余额不足告警", "发现 1 个渠道上游余额不足")

	captured := rec.capturedURL()
	require.Contains(t, captured, url.QueryEscape("渠道余额不足告警"))
	require.Contains(t, captured, url.QueryEscape("发现 1 个渠道上游余额不足"))
}

func TestNotifyChannelLowBalanceViaBarkSkipsWhenURLNotConfigured(t *testing.T) {
	resetBarkNotifySettings(t)
	disableSSRFForBarkTest(t)

	operation_setting.RechargeNotifyBarkUrl = ""

	// 未配置 Bark URL 时静默返回，不发请求
	rec := &barkURLRecorder{}
	server := httptest.NewServer(rec.handler())
	defer server.Close()

	// 把 RechargeNotifyBarkUrl 设为空，但确认不会打到任何服务器
	NotifyChannelLowBalanceViaBark("渠道余额不足告警", "content")
	assert.Empty(t, rec.capturedURL())
}
