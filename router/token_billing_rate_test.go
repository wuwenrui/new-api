package router

import (
	"crypto/sha256"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestBillingReadsDoNotConsumeCriticalApplicationAllowance(t *testing.T) {
	oldRedis, oldCritical, oldGlobal := common.RedisEnabled, common.CriticalRateLimitEnable, common.GlobalApiRateLimitEnable
	oldCriticalNum, oldCriticalDuration := common.CriticalRateLimitNum, common.CriticalRateLimitDuration
	oldGlobalNum, oldGlobalDuration := common.GlobalApiRateLimitNum, common.GlobalApiRateLimitDuration
	t.Cleanup(func() {
		common.RedisEnabled, common.CriticalRateLimitEnable, common.GlobalApiRateLimitEnable = oldRedis, oldCritical, oldGlobal
		common.CriticalRateLimitNum, common.CriticalRateLimitDuration = oldCriticalNum, oldCriticalDuration
		common.GlobalApiRateLimitNum, common.GlobalApiRateLimitDuration = oldGlobalNum, oldGlobalDuration
	})
	common.RedisEnabled, common.CriticalRateLimitEnable, common.GlobalApiRateLimitEnable = false, true, true
	common.CriticalRateLimitNum, common.CriticalRateLimitDuration = 1, 600
	common.GlobalApiRateLimitNum, common.GlobalApiRateLimitDuration = 10, 600
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	SetApiRouter(engine)
	// A per-fixture documentation IP avoids shared limiter state across repeats.
	digest := sha256.Sum256([]byte(t.TempDir()))
	ip := net.IP(append([]byte{0x20, 0x01, 0x0d, 0xb8}, digest[:12]...)).String()
	for _, tc := range []struct {
		path   string
		status int
	}{
		{"/api/usage/token/billing", http.StatusUnauthorized},
		{"/api/usage/token/billing", http.StatusUnauthorized},
		{"/api/usage/token/", http.StatusUnauthorized},
		{"/api/usage/token/", http.StatusTooManyRequests},
	} {
		req := httptest.NewRequest(http.MethodGet, tc.path, nil)
		req.RemoteAddr = net.JoinHostPort(ip, "1234")
		rec := httptest.NewRecorder()
		engine.ServeHTTP(rec, req)
		require.Equal(t, tc.status, rec.Code, tc.path)
	}
}
