package router

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newNoRouteTestEngine(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.NoRoute(webNoRouteHandler(ThemeAssets{
		DefaultIndexPage: []byte("<!doctype html><title>default</title>"),
		ClassicIndexPage: []byte("<!doctype html><title>classic</title>"),
	}))
	return engine
}

func TestWebNoRouteHandler(t *testing.T) {
	engine := newNoRouteTestEngine(t)

	tests := []struct {
		name        string
		path        string
		wantStatus  int
		wantHTML    bool
		wantNotHTML bool
		wantJSONErr bool
	}{
		{name: "missing hashed js chunk returns 404", path: "/static/js/7766.deadbeef00.js", wantStatus: http.StatusNotFound, wantNotHTML: true},
		{name: "missing hashed css chunk returns 404", path: "/static/css/index.deadbeef00.css", wantStatus: http.StatusNotFound, wantNotHTML: true},
		{name: "spa route falls back to index html", path: "/system-settings/site/system-info", wantStatus: http.StatusOK, wantHTML: true},
		{name: "api route returns json 404", path: "/api/nonexistent", wantStatus: http.StatusNotFound, wantJSONErr: true},
		{name: "relay route returns json 404", path: "/v1/nonexistent", wantStatus: http.StatusNotFound, wantJSONErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			rec := httptest.NewRecorder()
			engine.ServeHTTP(rec, req)

			require.Equal(t, tt.wantStatus, rec.Code)
			if tt.wantHTML {
				assert.Contains(t, rec.Header().Get("Content-Type"), "text/html")
				assert.Contains(t, rec.Body.String(), "<!doctype html>")
			}
			if tt.wantNotHTML {
				// The stale-chunk regression: index.html must never be served
				// for a missing /static asset.
				assert.NotContains(t, rec.Header().Get("Content-Type"), "text/html")
				assert.NotContains(t, rec.Body.String(), "<!doctype html>")
			}
			if tt.wantJSONErr {
				assert.Contains(t, rec.Header().Get("Content-Type"), "application/json")
			}
		})
	}
}
