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

func TestManualTopUpFacadeRoutesRequireAuthentication(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oldRedis := common.RedisEnabled
	common.RedisEnabled = false
	t.Cleanup(func() { common.RedisEnabled = oldRedis })
	engine := gin.New()
	SetApiRouter(engine)
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/options"}, {http.MethodPost, "/quote"},
		{http.MethodGet, "/orders"}, {http.MethodPost, "/orders"},
	} {
		rec := httptest.NewRecorder()
		engine.ServeHTTP(rec, httptest.NewRequest(route.method, "/api/billing/token/manual-topup"+route.path, nil))
		require.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
		assert.Contains(t, rec.Header().Get("Cache-Control"), "no-store")
	}
	for _, route := range []struct{ method, path string }{
		{http.MethodDelete, "/orders"}, {http.MethodPost, "/complete"}, {http.MethodPost, "/confirm-status"},
	} {
		rec := httptest.NewRecorder()
		engine.ServeHTTP(rec, httptest.NewRequest(route.method, "/api/billing/token/manual-topup"+route.path, nil))
		assert.Equal(t, http.StatusNotFound, rec.Code)
	}
}
