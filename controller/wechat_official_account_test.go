package controller

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func configureTestWeChatRelayKey(t *testing.T) {
	t.Helper()
	privateKey, err := rsa.GenerateKey(rand.Reader, 3072)
	require.NoError(t, err)
	keyPath := filepath.Join(t.TempDir(), "relay-private.pem")
	keyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(privateKey),
	})
	require.NoError(t, os.WriteFile(keyPath, keyPEM, 0o600))
	t.Setenv("WECHAT_RELAY_KEY_ID", "test-key")
	t.Setenv("WECHAT_RELAY_PRIVATE_KEY_PATH", keyPath)
}

func TestGetWeChatOfficialAccountRelayPublicKey(t *testing.T) {
	gin.SetMode(gin.TestMode)
	configureTestWeChatRelayKey(t)
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodGet, "/v1/wechat-official-account/public-key", nil)
	context.Set("id", 101)
	context.Set("token_id", 202)

	GetWeChatOfficialAccountRelayPublicKey(context)

	require.Equal(t, http.StatusOK, recorder.Code)
	var payload map[string]any
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &payload))
	require.Equal(t, true, payload["success"])
	data, ok := payload["data"].(map[string]any)
	require.True(t, ok)
	require.NotEmpty(t, data["keyId"])
	require.NotEmpty(t, data["publicKey"])
	require.Len(t, data["credentialBinding"], 64)
	require.Greater(t, int64(data["serverTime"].(float64)), int64(0))
	require.NotContains(t, recorder.Body.String(), "private")
}

func TestRelayWeChatOfficialAccountRejectsInvalidCiphertext(t *testing.T) {
	gin.SetMode(gin.TestMode)
	configureTestWeChatRelayKey(t)
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(
		http.MethodPost,
		"/v1/wechat-official-account/relay",
		bytes.NewBufferString(`{"keyId":"unknown","encryptedCredentials":"invalid","operation":{"action":"test_connection"}}`),
	)
	context.Request.Header.Set("Content-Type", "application/json")
	context.Set("id", 101)
	context.Set("token_id", 202)

	RelayWeChatOfficialAccount(context)

	require.Equal(t, http.StatusBadRequest, recorder.Code)
	var payload map[string]any
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &payload))
	require.Equal(t, false, payload["success"])
	relayError, ok := payload["error"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, "invalid_credential_envelope", relayError["code"])
	require.Equal(t, "invalid_request", relayError["category"])
}

func TestWriteWeChatRelayErrorMapsActionableCategories(t *testing.T) {
	tests := []struct {
		category string
		status   int
	}{
		{category: "credential_invalid", status: http.StatusUnauthorized},
		{category: "ip_not_whitelisted", status: http.StatusForbidden},
		{category: "material_permission_denied", status: http.StatusForbidden},
		{category: "draft_permission_denied", status: http.StatusForbidden},
		{category: "network_timeout", status: http.StatusServiceUnavailable},
		{category: "invalid_request", status: http.StatusBadRequest},
		{category: "rate_limited", status: http.StatusTooManyRequests},
	}

	for _, test := range tests {
		t.Run(test.category, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			context, _ := gin.CreateTestContext(recorder)
			writeWeChatRelayError(context, &service.WeChatRelayError{
				Category:  test.category,
				Message:   "action required",
				Retryable: test.category == "network_timeout",
			})

			require.Equal(t, test.status, recorder.Code)
			require.NotContains(t, recorder.Body.String(), "AppSecret")
		})
	}
}
