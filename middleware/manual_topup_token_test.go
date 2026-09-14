package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTokenManualTopUpAuthCurrentIdentity(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct {
		name   string
		mutate func(*testing.T, *model.Token, *model.User)
		status int
	}{
		{"enabled empty wallet", nil, http.StatusOK},
		{"exhausted", func(t *testing.T, token *model.Token, _ *model.User) {
			require.NoError(t, model.DB.Model(token).Update("status", common.TokenStatusExhausted).Error)
		}, http.StatusOK},
		{"disabled", func(t *testing.T, token *model.Token, _ *model.User) {
			require.NoError(t, model.DB.Model(token).Update("status", common.TokenStatusDisabled).Error)
		}, http.StatusUnauthorized},
		{"expired status", func(t *testing.T, token *model.Token, _ *model.User) {
			require.NoError(t, model.DB.Model(token).Update("status", common.TokenStatusExpired).Error)
		}, http.StatusUnauthorized},
		{"expired time", func(t *testing.T, token *model.Token, _ *model.User) {
			require.NoError(t, model.DB.Model(token).Update("expired_time", common.GetTimestamp()-1).Error)
		}, http.StatusUnauthorized},
		{"deleted token", func(t *testing.T, token *model.Token, _ *model.User) {
			require.NoError(t, model.DB.Delete(token).Error)
		}, http.StatusUnauthorized},
		{"rotated key", func(t *testing.T, token *model.Token, _ *model.User) {
			require.NoError(t, model.DB.Model(token).Update("key", "rotatedkey").Error)
		}, http.StatusUnauthorized},
		{"changed owner", func(t *testing.T, token *model.Token, _ *model.User) {
			require.NoError(t, model.DB.Model(token).Update("user_id", token.UserId+1).Error)
		}, http.StatusUnauthorized},
		{"banned owner", func(t *testing.T, _ *model.Token, user *model.User) {
			require.NoError(t, model.DB.Model(user).Update("status", common.UserStatusDisabled).Error)
		}, http.StatusForbidden},
		{"deleted owner", func(t *testing.T, _ *model.Token, user *model.User) { require.NoError(t, model.DB.Delete(user).Error) }, http.StatusForbidden},
		{"IP denied", func(t *testing.T, token *model.Token, _ *model.User) {
			require.NoError(t, model.DB.Model(token).Update("allow_ips", "192.0.2.0/24").Error)
		}, http.StatusForbidden},
		{"IP allowed", func(t *testing.T, token *model.Token, _ *model.User) {
			require.NoError(t, model.DB.Model(token).Update("allow_ips", "127.0.0.0/8").Error)
		}, http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			user := prepareSkillAuthTest(t)
			token := model.Token{UserId: user.Id, Key: "manualtopupkey", Status: common.TokenStatusEnabled, ExpiredTime: -1}
			require.NoError(t, model.DB.Create(&token).Error)
			router := gin.New()
			router.GET("/", TokenAuthReadOnly(), func(c *gin.Context) {
				// Simulate a cached identity becoming stale after initial parsing.
				if tc.mutate != nil {
					tc.mutate(t, &token, &user)
				}
				c.Next()
			}, TokenManualTopUpAuth(), func(c *gin.Context) {
				assert.Equal(t, user.Id, c.GetInt("id"))
				c.Status(http.StatusOK)
			})
			req := httptest.NewRequest(http.MethodGet, "/?user_id=999", nil)
			req.RemoteAddr = "127.0.0.1:1234"
			req.Header.Set("Authorization", "bearer sk-manualtopupkey-ignored")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			assert.Equal(t, tc.status, response.Code, response.Body.String())
		})
	}
}

func TestTokenManualTopUpAuthRequiresInitialAuthentication(t *testing.T) {
	router := gin.New()
	router.GET("/", TokenManualTopUpAuth(), func(c *gin.Context) { t.Fatal("unauthenticated request reached handler") })
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	assert.Equal(t, http.StatusUnauthorized, response.Code)
}

func TestManualTopUpWriteRateLimitUsesOwner(t *testing.T) {
	oldRedis, oldEnabled := common.RedisEnabled, common.CriticalRateLimitEnable
	oldNum, oldDuration := common.CriticalRateLimitNum, common.CriticalRateLimitDuration
	common.RedisEnabled, common.CriticalRateLimitEnable = false, true
	common.CriticalRateLimitNum, common.CriticalRateLimitDuration = 1, 60
	t.Cleanup(func() {
		common.RedisEnabled, common.CriticalRateLimitEnable = oldRedis, oldEnabled
		common.CriticalRateLimitNum, common.CriticalRateLimitDuration = oldNum, oldDuration
	})
	router := gin.New()
	router.Use(func(c *gin.Context) {
		if c.GetHeader("owner") == "other" {
			c.Set("id", 92002)
		} else {
			c.Set("id", 92001)
		}
	})
	router.POST("/", ManualTopUpWriteRateLimit(), func(c *gin.Context) { c.Status(http.StatusOK) })
	router.GET("/", func(c *gin.Context) { c.Status(http.StatusOK) })
	for _, tc := range []struct {
		method, owner, ip string
		status            int
	}{
		{http.MethodGet, "same", "127.0.0.1:1", 200},
		{http.MethodPost, "same", "127.0.0.1:1", 200},
		{http.MethodPost, "same", "192.0.2.1:2", 429},
		{http.MethodPost, "other", "127.0.0.1:1", 200},
		{http.MethodGet, "same", "127.0.0.1:1", 200},
	} {
		req := httptest.NewRequest(tc.method, "/", nil)
		req.Header.Set("owner", tc.owner)
		req.RemoteAddr = tc.ip
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		assert.Equal(t, tc.status, response.Code)
	}
}
