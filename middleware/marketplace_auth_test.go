package middleware

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func prepareMarketplaceAuthTest(t *testing.T) {
	t.Helper()
	originalDB := model.DB
	originalSQLitePath := common.SQLitePath
	originalRedis := common.RedisEnabled
	common.RedisEnabled = false
	common.SQLitePath = filepath.Join(t.TempDir(), "marketplace-auth.db")
	t.Setenv("SQL_DSN", "local")
	require.NoError(t, model.InitDB())
	require.NoError(t, model.DB.AutoMigrate(&model.User{}, &model.Token{}))
	t.Cleanup(func() {
		if sqlDB, err := model.DB.DB(); err == nil {
			_ = sqlDB.Close()
		}
		model.DB = originalDB
		common.SQLitePath = originalSQLitePath
		common.RedisEnabled = originalRedis
	})
}

func TestMarketplaceTokenAuthAllowsExhaustedQuotaButRejectsExpiry(t *testing.T) {
	prepareMarketplaceAuthTest(t)
	gin.SetMode(gin.TestMode)
	user := model.User{Username: "market-auth-reader", Password: "unused", Status: common.UserStatusEnabled, Role: common.RoleCommonUser, Quota: 0}
	require.NoError(t, model.DB.Create(&user).Error)
	token := model.Token{UserId: user.Id, Key: "marketkey", Name: "market", Status: common.TokenStatusExhausted, ExpiredTime: -1, RemainQuota: 0}
	require.NoError(t, model.DB.Create(&token).Error)

	router := gin.New()
	router.Use(MarketplaceTokenAuth())
	router.GET("/market", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"id": c.GetInt("id")}) })

	accepted := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/market", nil)
	request.Header.Set("Authorization", "Bearer sk-marketkey")
	router.ServeHTTP(accepted, request)
	require.Equal(t, http.StatusOK, accepted.Code)
	require.Contains(t, accepted.Body.String(), fmt.Sprintf("%d", user.Id))

	require.NoError(t, model.DB.Model(&token).Updates(map[string]any{
		"status":       common.TokenStatusEnabled,
		"expired_time": common.GetTimestamp() - 1,
	}).Error)
	expired := httptest.NewRecorder()
	router.ServeHTTP(expired, request.Clone(request.Context()))
	require.Equal(t, http.StatusUnauthorized, expired.Code)
}

func TestMarketplaceTokenAuthEnforcesTokenIPRestriction(t *testing.T) {
	prepareMarketplaceAuthTest(t)
	gin.SetMode(gin.TestMode)
	user := model.User{Username: "market-ip-reader", Password: "unused", Status: common.UserStatusEnabled}
	require.NoError(t, model.DB.Create(&user).Error)
	allow := "10.0.0.0/8"
	token := model.Token{UserId: user.Id, Key: "ipkey", Name: "market", Status: common.TokenStatusEnabled, ExpiredTime: -1, AllowIps: &allow}
	require.NoError(t, model.DB.Create(&token).Error)

	router := gin.New()
	router.Use(MarketplaceTokenAuth())
	router.GET("/market", func(c *gin.Context) { c.Status(http.StatusOK) })
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/market", nil)
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Authorization", "Bearer sk-ipkey")
	router.ServeHTTP(response, request)
	require.Equal(t, http.StatusForbidden, response.Code)
}
