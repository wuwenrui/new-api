package controller

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/oauth"
	"github.com/gin-contrib/sessions"
	"github.com/gin-contrib/sessions/cookie"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

type bindingTestOAuthProvider struct{}

func (*bindingTestOAuthProvider) GetName() string { return "Binding Test" }
func (*bindingTestOAuthProvider) IsEnabled() bool { return true }
func (*bindingTestOAuthProvider) ExchangeToken(context.Context, string, *gin.Context) (*oauth.OAuthToken, error) {
	return &oauth.OAuthToken{}, nil
}
func (*bindingTestOAuthProvider) GetUserInfo(context.Context, *oauth.OAuthToken) (*oauth.OAuthUser, error) {
	return &oauth.OAuthUser{ProviderUserID: "github-binding"}, nil
}
func (*bindingTestOAuthProvider) IsUserIDTaken(string) bool                      { return false }
func (*bindingTestOAuthProvider) FillUserByProviderID(*model.User, string) error { return nil }
func (*bindingTestOAuthProvider) SetProviderUserID(user *model.User, providerUserID string) {
	user.GitHubId = providerUserID
}
func (*bindingTestOAuthProvider) GetProviderPrefix() string    { return "binding_" }
func (*bindingTestOAuthProvider) ProviderUserIDColumn() string { return "github_id" }

func setupBindingControllerTest(t *testing.T) (*gorm.DB, *model.User) {
	t.Helper()
	previousDB := model.DB
	previousType := common.MainDatabaseType()
	previousWeChatEnabled := common.WeChatAuthEnabled
	previousWeChatAddress := common.WeChatServerAddress
	previousWeChatToken := common.WeChatServerToken

	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", strings.ReplaceAll(t.Name(), "/", "_"))
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.User{}))
	model.DB = db
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)

	user := &model.User{
		Username: "binding-test-user",
		Password: "password",
		Role:     common.RoleRootUser,
		Status:   common.UserStatusEnabled,
		Group:    "privileged",
	}
	require.NoError(t, db.Create(user).Error)

	t.Cleanup(func() {
		model.DB = previousDB
		common.SetMainDatabaseType(previousType)
		common.WeChatAuthEnabled = previousWeChatEnabled
		common.WeChatServerAddress = previousWeChatAddress
		common.WeChatServerToken = previousWeChatToken
		sqlDB, sqlErr := db.DB()
		if sqlErr == nil {
			_ = sqlDB.Close()
		}
	})
	return db, user
}

func installConcurrentRestriction(t *testing.T, db *gorm.DB, userID int) *error {
	t.Helper()
	var once sync.Once
	var restrictionErr error
	require.NoError(t, db.Callback().Update().Before("gorm:update").Register("test:concurrent-account-restriction", func(tx *gorm.DB) {
		if tx.Statement.Table != "users" {
			return
		}
		once.Do(func() {
			restrictionErr = tx.Exec(
				`UPDATE users SET status = ?, role = ?, "group" = ? WHERE id = ?`,
				common.UserStatusDisabled,
				common.RoleCommonUser,
				"restricted",
				userID,
			).Error
		})
	}))
	return &restrictionErr
}

func assertBindingPreservedRestriction(t *testing.T, db *gorm.DB, userID int, column string, wantBinding string) {
	t.Helper()
	var stored model.User
	require.NoError(t, db.First(&stored, userID).Error)
	assert.Equal(t, common.UserStatusDisabled, stored.Status)
	assert.Equal(t, common.RoleCommonUser, stored.Role)
	assert.Equal(t, "restricted", stored.Group)
	switch column {
	case "github_id":
		assert.Equal(t, wantBinding, stored.GitHubId)
	case "wechat_id":
		assert.Equal(t, wantBinding, stored.WeChatId)
	}
}

func TestOAuthBindOnlyUpdatesProviderColumn(t *testing.T) {
	db, user := setupBindingControllerTest(t)
	restrictionErr := installConcurrentRestriction(t, db, user.Id)

	router := gin.New()
	router.Use(sessions.Sessions("session", cookie.NewStore([]byte("oauth-binding-test"))))
	router.GET("/bind", func(c *gin.Context) {
		session := sessions.Default(c)
		session.Set("id", user.Id)
		handleOAuthBind(c, &bindingTestOAuthProvider{})
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/bind?code=test", nil)
	router.ServeHTTP(response, request)

	require.Equal(t, http.StatusOK, response.Code)
	require.NoError(t, *restrictionErr)
	assertBindingPreservedRestriction(t, db, user.Id, "github_id", "github-binding")
}

func TestWeChatBindOnlyUpdatesWechatColumn(t *testing.T) {
	db, user := setupBindingControllerTest(t)
	restrictionErr := installConcurrentRestriction(t, db, user.Id)
	wechatServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"message":"","data":"wechat-binding"}`))
	}))
	defer wechatServer.Close()
	common.WeChatAuthEnabled = true
	common.WeChatServerAddress = wechatServer.URL

	router := gin.New()
	router.Use(sessions.Sessions("session", cookie.NewStore([]byte("wechat-binding-test"))))
	router.POST("/bind", func(c *gin.Context) {
		session := sessions.Default(c)
		session.Set("id", user.Id)
		WeChatBind(c)
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/bind", strings.NewReader(`{"code":"test"}`))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(response, request)

	require.Equal(t, http.StatusOK, response.Code)
	require.NoError(t, *restrictionErr)
	assertBindingPreservedRestriction(t, db, user.Id, "wechat_id", "wechat-binding")
}
