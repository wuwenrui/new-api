package controller

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type pluginCatalogEnvelope struct {
	Success bool            `json:"success"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

type pluginCatalogDocumentPayload struct {
	Revision int64 `json:"revision"`
	Owned    []struct {
		ID        string `json:"id"`
		Directory string `json:"directory"`
		Enabled   bool   `json:"enabled"`
	} `json:"owned"`
	Community []struct {
		ID          string `json:"id"`
		PackageName string `json:"packageName"`
		Enabled     bool   `json:"enabled"`
	} `json:"community"`
	PublishRequests []struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	} `json:"publishRequests"`
}

// The catalog routes sit behind RootAuth in production; this harness supplies
// the authenticated identity that middleware would have installed.
func newPluginCatalogTestEngine() *gin.Engine {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	group := engine.Group("/api/plugin/catalog")
	group.Use(func(c *gin.Context) {
		c.Set("username", "root")
		c.Next()
	})
	group.GET("", GetPluginCatalog)
	group.POST("/owned", UpsertPluginCatalogOwnedEntry)
	group.DELETE("/owned/:id", DeletePluginCatalogOwnedEntry)
	group.GET("/owned/export", ExportPluginCatalogOwnedRegistry)
	group.GET("/community/search", SearchPluginCatalogCommunity)
	group.POST("/community", UpsertPluginCatalogCommunityEntry)
	group.DELETE("/community/:id", DeletePluginCatalogCommunityEntry)
	group.GET("/export", ExportPluginCatalogRegistry)
	group.GET("/publish", GetPluginCatalogPublishRequests)
	group.POST("/publish", RequestPluginCatalogPublish)
	return engine
}

func performPluginCatalogRequest(
	t *testing.T,
	engine *gin.Engine,
	method string,
	path string,
	body string,
) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("content-type", "application/json")
	}
	engine.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code)
	return recorder
}

func decodePluginCatalogEnvelope(t *testing.T, recorder *httptest.ResponseRecorder) pluginCatalogEnvelope {
	t.Helper()
	var envelope pluginCatalogEnvelope
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &envelope))
	return envelope
}

func decodePluginCatalogDocument(t *testing.T, envelope pluginCatalogEnvelope) pluginCatalogDocumentPayload {
	t.Helper()
	var document pluginCatalogDocumentPayload
	require.NoError(t, common.Unmarshal(envelope.Data, &document))
	return document
}

const validCatalogEntryBody = `{
	"id": "doc-review",
	"owner": "wuwenrui",
	"repo": "https://github.com/wuwenrui/dsh-plugin-doc-review",
	"packageName": "dsh-plugin-doc-review",
	"version": "1.2.0",
	"category": "法律",
	"enabled": true
}`

func usePluginCatalogTestFile(t *testing.T) {
	t.Helper()
	t.Setenv("PLUGIN_CATALOG_PATH", filepath.Join(t.TempDir(), "plugin-catalog.json"))
	t.Setenv("PLUGIN_CATALOG_PUBLISH_WEBHOOK", "")
}

const validOwnedEntryBody = `{
	"id": "lawyer-contract",
	"directory": "packages/lawyer-contract",
	"name": "合同审稿",
	"description": "逐条风险清单与修改建议",
	"category": "合同",
	"enabled": true
}`

func TestUpsertPluginCatalogOwnedEntryStoresAndTogglesEntry(t *testing.T) {
	usePluginCatalogTestFile(t)
	engine := newPluginCatalogTestEngine()

	envelope := decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodPost, "/api/plugin/catalog/owned", validOwnedEntryBody))

	require.True(t, envelope.Success, envelope.Message)
	document := decodePluginCatalogDocument(t, envelope)
	assert.Equal(t, int64(1), document.Revision)
	require.Len(t, document.Owned, 1)
	assert.Equal(t, "packages/lawyer-contract", document.Owned[0].Directory)

	disabled := strings.Replace(validOwnedEntryBody, `"enabled": true`, `"enabled": false`, 1)
	toggled := decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodPost, "/api/plugin/catalog/owned", disabled))
	require.True(t, toggled.Success, toggled.Message)
	payload := decodePluginCatalogDocument(t, toggled)
	require.Len(t, payload.Owned, 1)
	assert.False(t, payload.Owned[0].Enabled)
	assert.Equal(t, int64(2), payload.Revision)
}

func TestUpsertPluginCatalogOwnedEntryRejectsDirectoryOutsideTheRepository(t *testing.T) {
	usePluginCatalogTestFile(t)
	engine := newPluginCatalogTestEngine()

	envelope := decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodPost, "/api/plugin/catalog/owned", `{"id":"lawyer-contract","directory":"packages/../../etc","name":"x","description":"y","category":"合同","enabled":true}`))

	assert.False(t, envelope.Success)
	assert.Contains(t, envelope.Message, "插件目录")
}

func TestDeletePluginCatalogOwnedEntryRemovesEntry(t *testing.T) {
	usePluginCatalogTestFile(t)
	engine := newPluginCatalogTestEngine()
	require.True(t, decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodPost, "/api/plugin/catalog/owned", validOwnedEntryBody)).Success)

	envelope := decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodDelete, "/api/plugin/catalog/owned/lawyer-contract", ""))

	require.True(t, envelope.Success, envelope.Message)
	assert.Empty(t, decodePluginCatalogDocument(t, envelope).Owned)
}

func TestExportPluginCatalogOwnedRegistryReturnsBareArray(t *testing.T) {
	usePluginCatalogTestFile(t)
	engine := newPluginCatalogTestEngine()
	require.True(t, decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodPost, "/api/plugin/catalog/owned", validOwnedEntryBody)).Success)

	recorder := performPluginCatalogRequest(t, engine, http.MethodGet, "/api/plugin/catalog/owned/export", "")

	assert.Equal(t, `attachment; filename="approved.json"`, recorder.Header().Get("content-disposition"))
	var entries []struct {
		ID        string `json:"id"`
		Directory string `json:"directory"`
		Enabled   bool   `json:"enabled"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &entries))
	require.Len(t, entries, 1)
	assert.Equal(t, "packages/lawyer-contract", entries[0].Directory)
	assert.True(t, entries[0].Enabled)
}

func TestGetPluginCatalogReturnsEmptyRegistry(t *testing.T) {
	usePluginCatalogTestFile(t)
	engine := newPluginCatalogTestEngine()

	envelope := decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodGet, "/api/plugin/catalog", ""))

	assert.True(t, envelope.Success)
	document := decodePluginCatalogDocument(t, envelope)
	assert.Equal(t, int64(0), document.Revision)
	assert.Empty(t, document.Community)
}

func TestUpsertPluginCatalogCommunityEntryStoresAndReturnsDocument(t *testing.T) {
	usePluginCatalogTestFile(t)
	engine := newPluginCatalogTestEngine()

	envelope := decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodPost, "/api/plugin/catalog/community", validCatalogEntryBody))

	require.True(t, envelope.Success, envelope.Message)
	document := decodePluginCatalogDocument(t, envelope)
	assert.Equal(t, int64(1), document.Revision)
	require.Len(t, document.Community, 1)
	assert.Equal(t, "doc-review", document.Community[0].ID)

	reloaded := decodePluginCatalogDocument(t, decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodGet, "/api/plugin/catalog", "")))
	require.Len(t, reloaded.Community, 1)
	assert.Equal(t, "dsh-plugin-doc-review", reloaded.Community[0].PackageName)
}

func TestUpsertPluginCatalogCommunityEntryRejectsInvalidEntryWithoutWriting(t *testing.T) {
	usePluginCatalogTestFile(t)
	engine := newPluginCatalogTestEngine()

	envelope := decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodPost, "/api/plugin/catalog/community", `{"id":"Bad ID","owner":"wuwenrui","repo":"https://github.com/wuwenrui/x","packageName":"dsh-plugin-x","version":"1.0.0","category":"社区","enabled":true}`))

	assert.False(t, envelope.Success)
	assert.Contains(t, envelope.Message, "插件标识")
	document := decodePluginCatalogDocument(t, decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodGet, "/api/plugin/catalog", "")))
	assert.Equal(t, int64(0), document.Revision)
	assert.Empty(t, document.Community)
}

func TestDeletePluginCatalogCommunityEntryRemovesEntry(t *testing.T) {
	usePluginCatalogTestFile(t)
	engine := newPluginCatalogTestEngine()
	require.True(t, decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodPost, "/api/plugin/catalog/community", validCatalogEntryBody)).Success)

	envelope := decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodDelete, "/api/plugin/catalog/community/doc-review", ""))

	require.True(t, envelope.Success, envelope.Message)
	assert.Empty(t, decodePluginCatalogDocument(t, envelope).Community)
}

func TestExportPluginCatalogRegistryReturnsPublisherPayload(t *testing.T) {
	usePluginCatalogTestFile(t)
	engine := newPluginCatalogTestEngine()
	require.True(t, decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodPost, "/api/plugin/catalog/community", validCatalogEntryBody)).Success)

	recorder := performPluginCatalogRequest(t, engine, http.MethodGet, "/api/plugin/catalog/export", "")

	assert.Equal(t, `attachment; filename="community-approved.json"`, recorder.Header().Get("content-disposition"))
	payload := recorder.Body.String()
	assert.Contains(t, payload, `"schemaVersion":1`)
	assert.Contains(t, payload, "doc-review")
}

func TestRequestPluginCatalogPublishRecordsPendingRequest(t *testing.T) {
	usePluginCatalogTestFile(t)
	engine := newPluginCatalogTestEngine()

	envelope := decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodPost, "/api/plugin/catalog/publish", `{"note":"上架合同审阅"}`))

	require.True(t, envelope.Success, envelope.Message)
	var requests []struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	require.NoError(t, common.Unmarshal(envelope.Data, &requests))
	require.Len(t, requests, 1)
	assert.Equal(t, "pending", requests[0].Status)

	listed := decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodGet, "/api/plugin/catalog/publish", ""))
	require.True(t, listed.Success)
	var history []struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	require.NoError(t, common.Unmarshal(listed.Data, &history))
	require.Len(t, history, 1)
	assert.Equal(t, requests[0].ID, history[0].ID)
}

func TestSearchPluginCatalogCommunityMarksOpenedPlugins(t *testing.T) {
	usePluginCatalogTestFile(t)
	community := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/json")
		_, err := writer.Write([]byte(`{"plugins":[{"name":"doc-review","owner":"wuwenrui","url":"https://github.com/wuwenrui/dsh-plugin-doc-review","npm":"dsh-plugin-doc-review","version":"1.2.0","category":"法律","description":{"zh":"合同审阅"},"deprecated":false}]}`))
		require.NoError(t, err)
	}))
	t.Cleanup(community.Close)
	t.Setenv("PLUGIN_CATALOG_COMMUNITY_URL", community.URL)
	engine := newPluginCatalogTestEngine()
	require.True(t, decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodPost, "/api/plugin/catalog/community", validCatalogEntryBody)).Success)

	envelope := decodePluginCatalogEnvelope(t, performPluginCatalogRequest(t, engine, http.MethodGet, "/api/plugin/catalog/community/search?q=合同", ""))

	require.True(t, envelope.Success, envelope.Message)
	var results []struct {
		Name        string `json:"name"`
		PackageName string `json:"packageName"`
		Description string `json:"description"`
		AlreadyOpen bool   `json:"alreadyOpen"`
		OpenEnabled bool   `json:"openEnabled"`
	}
	require.NoError(t, common.Unmarshal(envelope.Data, &results))
	require.Len(t, results, 1)
	assert.Equal(t, "doc-review", results[0].Name)
	assert.Equal(t, "合同审阅", results[0].Description)
	assert.True(t, results[0].AlreadyOpen)
	assert.True(t, results[0].OpenEnabled)
}
