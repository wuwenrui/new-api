package router

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/service/authz"
	"github.com/gin-contrib/sessions"
	"github.com/gin-contrib/sessions/cookie"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestChannelStatusRoutesUseOperatePermission(t *testing.T) {
	assertChannelRoutePermission(t, http.MethodPost, "/:id/status", authz.ChannelOperate, controller.UpdateChannelStatus)
	assertChannelRoutePermission(t, http.MethodPost, "/status/batch", authz.ChannelOperate, controller.BatchUpdateChannelStatus)
	assertChannelRoutePermission(t, http.MethodPut, "/", authz.ChannelWrite, controller.UpdateChannel)
}

func TestChannelDeleteRoutesUseSensitiveWritePermission(t *testing.T) {
	assertChannelRoutePermission(t, http.MethodDelete, "/:id", authz.ChannelSensitiveWrite, controller.DeleteChannel)
	assertChannelRoutePermission(t, http.MethodPost, "/batch", authz.ChannelSensitiveWrite, controller.DeleteChannelBatch)
	assertChannelRoutePermission(t, http.MethodDelete, "/disabled", authz.ChannelSensitiveWrite, controller.DeleteDisabledChannel)
	assertChannelRoutePermission(t, http.MethodPut, "/", authz.ChannelWrite, controller.UpdateChannel)
	assertChannelRoutePermission(t, http.MethodPut, "/tag", authz.ChannelWrite, controller.EditTagChannels)
	assertChannelRoutePermission(t, http.MethodPost, "/batch/tag", authz.ChannelWrite, controller.BatchSetChannelTag)
}

func TestChannelPriceCompareRouteIsSuperAdminOnly(t *testing.T) {
	// The pricing workbench (costs, margins, profit) must not be reachable
	// through the shared permission list — it is registered with RootAuth.
	for _, route := range channelPermissionRoutes {
		require.NotEqual(t, "/price_compare", route.path)
	}

	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(sessions.Sessions("session", cookie.NewStore([]byte("channel-route-test"))))
	engine.GET("/set-admin-session", func(c *gin.Context) {
		session := sessions.Default(c)
		session.Set("username", "admin")
		session.Set("role", common.RoleAdminUser)
		session.Set("id", 2)
		session.Set("status", 1)
		require.NoError(t, session.Save())
		c.Status(http.StatusNoContent)
	})
	registerChannelRoutes(engine.Group("/api"))

	login := httptest.NewRecorder()
	engine.ServeHTTP(login, httptest.NewRequest(http.MethodGet, "/set-admin-session", nil))
	cookies := login.Result().Cookies()
	require.NotEmpty(t, cookies)

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/channel/price_compare", nil)
	request.Header.Set("New-Api-User", "2")
	for _, cookie := range cookies {
		request.AddCookie(cookie)
	}
	engine.ServeHTTP(response, request)

	// Regular admins are rejected before the handler runs (the auth helper
	// answers 200 with success:false on insufficient privilege).
	assert.Contains(t, response.Body.String(), `"success":false`)
}

func TestChannelBusinessReportRouteUsesReadPermission(t *testing.T) {
	assertChannelRoutePermission(t, http.MethodGet, "/business_report", authz.ChannelRead, controller.GetChannelBusinessReport)
}

func TestChannelPriceCompareRouteRejectsUnauthenticatedRequests(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(sessions.Sessions("session", cookie.NewStore([]byte("channel-route-test"))))
	registerChannelRoutes(engine.Group("/api"))

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/channel/price_compare", nil)
	engine.ServeHTTP(response, request)

	assert.Equal(t, http.StatusUnauthorized, response.Code)
}

func TestChannelStatusRoutesRegisterWithoutConflict(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	api := engine.Group("/api")

	require.NotPanics(t, func() {
		registerChannelRoutes(api)
	})
}

func assertChannelRoutePermission(t *testing.T, method string, path string, permission authz.Permission, handler any) {
	t.Helper()
	for _, route := range channelPermissionRoutes {
		if route.method == method && route.path == path {
			assert.Equal(t, permission, route.permission)
			assert.Equal(t, reflect.ValueOf(handler).Pointer(), reflect.ValueOf(route.handler).Pointer())
			return
		}
	}
	t.Fatalf("route %s %s not found", method, path)
}
