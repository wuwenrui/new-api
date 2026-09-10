package router

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-contrib/sessions"
	"github.com/gin-contrib/sessions/cookie"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The managed plugin catalog is the operator-owned allowlist the release
// publisher signs; a route silently disappearing would take the admin page with
// The dashboard auth helper reads the session middleware, so the test engine
// installs the same store the server does before registering the API routes.
func newPluginCatalogTestEngine() *gin.Engine {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(sessions.Sessions("session", cookie.NewStore([]byte("plugin-catalog-route-test"))))
	SetApiRouter(engine)
	return engine
}

// it, so the wiring itself is the contract under test.
func TestPluginCatalogRoutesAreRegistered(t *testing.T) {
	engine := newPluginCatalogTestEngine()

	registered := make(map[string]bool, len(engine.Routes()))
	for _, route := range engine.Routes() {
		registered[route.Method+" "+route.Path] = true
	}
	for _, want := range []string{
		http.MethodGet + " /api/plugin/catalog",
		http.MethodPost + " /api/plugin/catalog/owned",
		http.MethodDelete + " /api/plugin/catalog/owned/:id",
		http.MethodGet + " /api/plugin/catalog/owned/export",
		http.MethodGet + " /api/plugin/catalog/community/search",
		http.MethodPost + " /api/plugin/catalog/community",
		http.MethodDelete + " /api/plugin/catalog/community/:id",
		http.MethodGet + " /api/plugin/catalog/export",
		http.MethodGet + " /api/plugin/catalog/publish",
		http.MethodPost + " /api/plugin/catalog/publish",
	} {
		assert.True(t, registered[want], "route %s is not registered", want)
	}
}

func TestPluginCatalogRoutesRejectAnonymousRequests(t *testing.T) {
	engine := newPluginCatalogTestEngine()

	for _, path := range []string{
		"/api/plugin/catalog",
		"/api/plugin/catalog/community/search",
		"/api/plugin/catalog/export",
		"/api/plugin/catalog/publish",
	} {
		t.Run(path, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, path, nil)

			engine.ServeHTTP(recorder, request)

			require.NotEqual(t, http.StatusOK, recorder.Code)
			assert.Equal(t, http.StatusUnauthorized, recorder.Code)
		})
	}
}
