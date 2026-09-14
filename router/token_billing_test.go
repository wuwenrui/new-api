package router

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTokenBillingRouteRequiresReadOnlyAuthentication(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oldRedis := common.RedisEnabled
	common.RedisEnabled = false
	t.Cleanup(func() { common.RedisEnabled = oldRedis })
	engine := gin.New()
	SetApiRouter(engine)
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/usage/token/billing", nil))
	require.Equal(t, http.StatusUnauthorized, recorder.Code, recorder.Body.String())
	assert.Contains(t, recorder.Header().Get("Cache-Control"), "no-store")
	var result struct {
		Success bool `json:"success"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &result))
	assert.False(t, result.Success)
}
