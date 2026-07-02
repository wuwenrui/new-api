package controller

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNormalizeProbeBaseURL(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{"strips trailing slash", "https://example.com/", "https://example.com", false},
		{"strips path", "https://example.com/console/personal", "https://example.com", false},
		{"keeps port", "http://10.0.0.1:3000", "http://10.0.0.1:3000", false},
		{"rejects missing scheme", "example.com", "", true},
		{"rejects non-http scheme", "ftp://example.com", "", true},
		{"rejects empty", "", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizeProbeBaseURL(tt.input)
			if tt.wantErr {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}

func probeRequest(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	req := httptest.NewRequest(http.MethodPost, "/api/channel/probe_newapi", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	c.Request = req
	ProbeNewAPIUpstream(c)
	return w
}

func TestProbeNewAPIUpstreamSuccess(t *testing.T) {
	var gotAuth, gotUser string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/status" {
			_, _ = w.Write([]byte(`{"success": true, "data": {"quota_display_type": "CNY", "usd_exchange_rate": 7.2, "price": 1}}`))
			return
		}
		require.Equal(t, "/api/pricing", r.URL.Path)
		gotAuth = r.Header.Get("Authorization")
		gotUser = r.Header.Get("New-Api-User")
		_, _ = w.Write([]byte(`{
			"success": true,
			"data": [
				{"model_name": "claude-sonnet-4-5", "quota_type": 0, "model_ratio": 0.215,
				 "completion_ratio": 4.97, "cache_ratio": 0.1, "create_cache_ratio": 1.25,
				 "enable_groups": ["ClaudeCode-Max"], "supported_endpoint_types": ["anthropic", "openai"]}
			],
			"group_ratio": {"ClaudeCode-Max": 1.5},
			"usable_group": {"ClaudeCode-Max": "Max pool"}
		}`))
	}))
	defer upstream.Close()

	w := probeRequest(t, `{"base_url": "`+upstream.URL+`/", "access_token": "tok123", "user_id": "1"}`)

	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "Bearer tok123", gotAuth)
	assert.Equal(t, "1", gotUser)

	var resp struct {
		Success bool `json:"success"`
		Data    struct {
			BaseURL     string               `json:"base_url"`
			Models      []NewAPIProbeModel   `json:"models"`
			GroupRatio  map[string]float64   `json:"group_ratio"`
			UsableGroup map[string]string    `json:"usable_group"`
			RateInfo    *NewAPIProbeRateInfo `json:"rate_info"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(w.Body.Bytes(), &resp))
	require.True(t, resp.Success)
	assert.Equal(t, upstream.URL, resp.Data.BaseURL)
	require.Len(t, resp.Data.Models, 1)
	assert.Equal(t, "claude-sonnet-4-5", resp.Data.Models[0].ModelName)
	assert.Equal(t, 0.215, resp.Data.Models[0].ModelRatio)
	assert.Equal(t, []string{"ClaudeCode-Max"}, resp.Data.Models[0].EnableGroups)
	assert.Equal(t, 1.5, resp.Data.GroupRatio["ClaudeCode-Max"])
	assert.Equal(t, "Max pool", resp.Data.UsableGroup["ClaudeCode-Max"])
	require.NotNil(t, resp.Data.RateInfo)
	assert.Equal(t, "CNY", resp.Data.RateInfo.QuotaDisplayType)
	assert.Equal(t, 7.2, resp.Data.RateInfo.USDExchangeRate)
}

func TestProbeNewAPIUpstreamFailures(t *testing.T) {
	unauthorized := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer unauthorized.Close()

	emptyModels := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success": true, "data": []}`))
	}))
	defer emptyModels.Close()

	notJSON := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html>hello</html>`))
	}))
	defer notJSON.Close()

	tests := []struct {
		name string
		body string
	}{
		{"invalid base url", `{"base_url": "not-a-url"}`},
		{"upstream non-200", `{"base_url": "` + unauthorized.URL + `"}`},
		{"upstream empty models", `{"base_url": "` + emptyModels.URL + `"}`},
		{"upstream not json", `{"base_url": "` + notJSON.URL + `"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := probeRequest(t, tt.body)
			require.Equal(t, http.StatusOK, w.Code)
			var resp struct {
				Success bool   `json:"success"`
				Message string `json:"message"`
			}
			require.NoError(t, common.Unmarshal(w.Body.Bytes(), &resp))
			assert.False(t, resp.Success)
			assert.NotEmpty(t, resp.Message)
		})
	}
}
