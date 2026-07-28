package middleware

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-contrib/sessions"
	"github.com/gin-contrib/sessions/cookie"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func prepareSkillAuthTest(t *testing.T) model.User {
	t.Helper()
	originalDB := model.DB
	originalSQLitePath := common.SQLitePath
	originalRedisEnabled := common.RedisEnabled
	common.RedisEnabled = false
	common.SQLitePath = filepath.Join(t.TempDir(), "skill-auth.db")
	t.Setenv("SQL_DSN", "local")
	require.NoError(t, model.InitDB())
	require.NoError(t, model.DB.AutoMigrate(&model.User{}, &model.Token{}))
	t.Cleanup(func() {
		if sqlDB, err := model.DB.DB(); err == nil {
			_ = sqlDB.Close()
		}
		model.DB = originalDB
		common.SQLitePath = originalSQLitePath
		common.RedisEnabled = originalRedisEnabled
	})

	user := model.User{
		Username: "desktop-reader",
		Password: "unused",
		Status:   common.UserStatusEnabled,
		Role:     common.RoleCommonUser,
	}
	require.NoError(t, model.DB.Create(&user).Error)
	return user
}

func skillAuthRouter(injectSessionUser *model.User) *gin.Engine {
	router := gin.New()
	router.Use(sessions.Sessions("session", cookie.NewStore([]byte("skill-auth-test"))))
	if injectSessionUser != nil {
		router.Use(func(c *gin.Context) {
			session := sessions.Default(c)
			session.Set("username", injectSessionUser.Username)
			session.Set("role", injectSessionUser.Role)
			session.Set("id", injectSessionUser.Id)
			session.Set("status", injectSessionUser.Status)
			session.Set("group", injectSessionUser.Group)
			c.Next()
		})
	}
	router.GET("/api/skills/accessible", UserOrTokenAuthReadOnly(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"id": c.GetInt("id")})
	})
	return router
}

func TestUserOrTokenAuthReadOnlyAcceptsModelApiKey(t *testing.T) {
	gin.SetMode(gin.TestMode)
	user := prepareSkillAuthTest(t)
	require.NoError(t, model.DB.Create(&model.Token{
		UserId: user.Id,
		Key:    "desktopskillkey",
		Name:   "desktop",
		Status: common.TokenStatusEnabled,
	}).Error)

	request := httptest.NewRequest(http.MethodGet, "/api/skills/accessible", nil)
	request.Header.Set("Authorization", "Bearer sk-desktopskillkey")
	response := httptest.NewRecorder()
	skillAuthRouter(nil).ServeHTTP(response, request)

	require.Equal(t, http.StatusOK, response.Code)
	require.JSONEq(t, `{"id":`+strconv.Itoa(user.Id)+`}`, response.Body.String())
}

func TestUserOrTokenAuthReadOnlyPreservesSessionValidation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	user := prepareSkillAuthTest(t)

	request := httptest.NewRequest(http.MethodGet, "/api/skills/accessible", nil)
	request.Header.Set("New-Api-User", strconv.Itoa(user.Id))
	response := httptest.NewRecorder()
	skillAuthRouter(&user).ServeHTTP(response, request)

	require.Equal(t, http.StatusOK, response.Code)
	require.JSONEq(t, `{"id":`+strconv.Itoa(user.Id)+`}`, response.Body.String())
}
