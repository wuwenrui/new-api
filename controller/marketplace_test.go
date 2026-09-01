package controller

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func prepareMarketplaceControllerTest(t *testing.T) {
	t.Helper()
	originalDB := model.DB
	originalServerAddress := system_setting.ServerAddress
	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", t.Name())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.MarketPlugin{}, &model.MarketPluginVersion{}, &model.MarketPluginUserAccess{}))
	model.DB = db
	system_setting.ServerAddress = "https://model.example.com"
	t.Cleanup(func() {
		model.DB = originalDB
		system_setting.ServerAddress = originalServerAddress
	})
}

func TestMarketplaceCatalogAndDownloadEnforceUserAccess(t *testing.T) {
	prepareMarketplaceControllerTest(t)
	gin.SetMode(gin.TestMode)
	reader := model.User{Username: "market-controller-reader", Password: "unused", Status: common.UserStatusEnabled, Role: common.RoleCommonUser}
	require.NoError(t, model.DB.Create(&reader).Error)
	content := []byte("marketplace-artifact")
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	der, err := x509.MarshalPKIXPublicKey(publicKey)
	require.NoError(t, err)
	keys, err := common.Marshal(map[string]string{
		"test-key": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})),
	})
	require.NoError(t, err)
	t.Setenv("MARKETPLACE_SIGNING_PUBLIC_KEYS", string(keys))
	publishInput := service.MarketplacePublishInput{
		PluginKey:      "lawyer-office",
		PackageName:    "@lawyercopilot/plugin-office",
		DisplayName:    "律师办公",
		Category:       "office",
		Visibility:     model.MarketPluginVisibilityPrivate,
		Version:        "1.0.0",
		MinHostVersion: "0.1.2-alpha.1",
		MaxHostVersion: "0.1.2-alpha.1",
		Platforms:      []string{"any"},
		Architectures:  []string{"any"},
		Permissions:    []string{"filesystem:workspace-read"},
		Content:        content,
		DeclaredHash:   hex.EncodeToString(common.Sha256Raw(content)),
		SigningKeyID:   "test-key",
		UserIDs:        []int{reader.Id},
	}
	payload, err := service.MarketplaceSignaturePayload(publishInput, publishInput.DeclaredHash, int64(len(content)))
	require.NoError(t, err)
	publishInput.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	plugin, err := service.PublishMarketplacePlugin(publishInput)
	require.NoError(t, err)

	authorized := gin.New()
	authorized.Use(func(c *gin.Context) {
		c.Set("id", reader.Id)
		c.Set("role", common.RoleCommonUser)
		c.Next()
	})
	authorized.GET("/api/marketplace/catalog", GetMarketplaceCatalog)
	authorized.GET("/api/marketplace/plugins/:id/versions/:version/download", DownloadMarketplacePlugin)

	catalog := performMarketplaceRequest(authorized, http.MethodGet, "/api/marketplace/catalog", nil)
	require.Equal(t, http.StatusOK, catalog.Code)
	var body service.MarketplaceCatalog
	require.NoError(t, common.Unmarshal(catalog.Body.Bytes(), &body))
	require.Len(t, body.Plugins, 1)
	require.Equal(t, plugin.PluginKey, body.Plugins[0].ID)
	var wire map[string]any
	require.NoError(t, common.Unmarshal(catalog.Body.Bytes(), &wire))
	require.Contains(t, wire, "schemaVersion")
	require.Contains(t, wire, "generatedAt")
	require.Contains(t, wire, "expiresAt")
	plugins, ok := wire["plugins"].([]any)
	require.True(t, ok)
	require.Len(t, plugins, 1)
	wirePlugin, ok := plugins[0].(map[string]any)
	require.True(t, ok)
	require.Equal(t, "@lawyercopilot/plugin-office", wirePlugin["packageName"])
	require.Contains(t, wirePlugin, "compat")
	wireArtifact, ok := wirePlugin["artifact"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, "tgz", wireArtifact["format"])
	require.Equal(t, "test-key", wireArtifact["keyId"])

	download := performMarketplaceRequest(authorized, http.MethodGet, "/api/marketplace/plugins/lawyer-office/versions/1.0.0/download", nil)
	require.Equal(t, http.StatusOK, download.Code)
	require.Equal(t, content, download.Body.Bytes())
	require.Equal(t, body.Plugins[0].Artifact.SHA256, download.Header().Get("X-Artifact-SHA256"))

	unauthorized := gin.New()
	unauthorized.Use(func(c *gin.Context) { c.Set("id", reader.Id+100); c.Next() })
	unauthorized.GET("/api/marketplace/plugins/:id/versions/:version/download", DownloadMarketplacePlugin)
	response := performMarketplaceRequest(unauthorized, http.MethodGet, "/api/marketplace/plugins/lawyer-office/versions/1.0.0/download", nil)
	require.Equal(t, http.StatusNotFound, response.Code)
}

func TestAdminPublishMarketplacePluginValidatesArtifactHash(t *testing.T) {
	prepareMarketplaceControllerTest(t)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/api/marketplace/admin/plugins", AdminPublishMarketplacePlugin)
	request, err := common.Marshal(map[string]any{
		"plugin_id":        "lawyer-office",
		"package_name":     "@lawyercopilot/plugin-office",
		"display_name":     "律师办公",
		"category":         "office",
		"visibility":       "private",
		"version":          "1.0.0",
		"min_host_version": "0.1.2-alpha.1",
		"max_host_version": "0.1.2-alpha.1",
		"platforms":        []string{"any"},
		"architectures":    []string{"any"},
		"content_b64":      base64.StdEncoding.EncodeToString([]byte("artifact")),
		"sha256":           "wrong",
		"signature":        base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize)),
		"signing_key_id":   "test-key",
	})
	require.NoError(t, err)
	response := performMarketplaceRequest(router, http.MethodPost, "/api/marketplace/admin/plugins", request)
	require.Equal(t, http.StatusBadRequest, response.Code)
	require.Contains(t, response.Body.String(), "SHA-256")

	unknown := []byte(strings.TrimSuffix(string(request), "}") + `,"unexpected_contract_field":true}`)
	unknownResponse := performMarketplaceRequest(router, http.MethodPost, "/api/marketplace/admin/plugins", unknown)
	require.Equal(t, http.StatusBadRequest, unknownResponse.Code)
	require.Contains(t, unknownResponse.Body.String(), "unknown field")

	duplicate := performMarketplaceRequest(router, http.MethodPost, "/api/marketplace/admin/plugins", []byte(`{"plugin_id":"a","plugin_id":"b"}`))
	require.Equal(t, http.StatusBadRequest, duplicate.Code)
	require.Contains(t, duplicate.Body.String(), "重复字段")

	trailing := performMarketplaceRequest(router, http.MethodPost, "/api/marketplace/admin/plugins", []byte(`{} {}`))
	require.Equal(t, http.StatusBadRequest, trailing.Code)
	require.Contains(t, trailing.Body.String(), "多余值")

	missing := performMarketplaceRequest(router, http.MethodPost, "/api/marketplace/admin/plugins", []byte(`{}`))
	require.Equal(t, http.StatusBadRequest, missing.Code)
	require.Contains(t, missing.Body.String(), "无效")
}

func performMarketplaceRequest(router http.Handler, method, path string, body []byte) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}
