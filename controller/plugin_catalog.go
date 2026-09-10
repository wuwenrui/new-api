package controller

import (
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

// GetPluginCatalog returns the whole registry document for the admin page.
func GetPluginCatalog(c *gin.Context) {
	document, err := service.LoadPluginCatalog()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, document)
}

// SearchPluginCatalogCommunity searches the upstream community catalog.
func SearchPluginCatalogCommunity(c *gin.Context) {
	results, err := service.SearchPluginCatalogCommunity(c.Query("q"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, results)
}

// UpsertPluginCatalogOwnedEntry adds or updates one first-party plugin.
func UpsertPluginCatalogOwnedEntry(c *gin.Context) {
	var entry service.PluginCatalogOwnedEntry
	if err := common.DecodeJson(c.Request.Body, &entry); err != nil {
		common.ApiErrorMsg(c, "请求体不是有效的插件条目")
		return
	}
	document, err := service.UpsertPluginCatalogOwnedEntry(entry, c.GetString("username"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, document)
}

// DeletePluginCatalogOwnedEntry removes one first-party plugin from the list.
func DeletePluginCatalogOwnedEntry(c *gin.Context) {
	document, err := service.DeletePluginCatalogOwnedEntry(strings.TrimSpace(c.Param("id")))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, document)
}

// ExportPluginCatalogOwnedRegistry returns the operator list the release publisher packs from.
func ExportPluginCatalogOwnedRegistry(c *gin.Context) {
	payload, err := service.ExportPluginCatalogOwnedRegistry()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.Header("content-disposition", `attachment; filename="approved.json"`)
	c.Data(http.StatusOK, "application/json; charset=utf-8", payload)
}

// UpsertPluginCatalogCommunityEntry opens or updates one community plugin.
func UpsertPluginCatalogCommunityEntry(c *gin.Context) {
	var entry service.PluginCatalogCommunityEntry
	if err := common.DecodeJson(c.Request.Body, &entry); err != nil {
		common.ApiErrorMsg(c, "请求体不是有效的插件条目")
		return
	}
	document, err := service.UpsertPluginCatalogCommunityEntry(entry, c.GetString("username"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, document)
}

// DeletePluginCatalogCommunityEntry closes one community plugin.
func DeletePluginCatalogCommunityEntry(c *gin.Context) {
	document, err := service.DeletePluginCatalogCommunityEntry(strings.TrimSpace(c.Param("id")))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, document)
}

// ExportPluginCatalogRegistry returns the registry the release publisher consumes.
func ExportPluginCatalogRegistry(c *gin.Context) {
	payload, err := service.ExportPluginCatalogRegistry()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.Header("content-disposition", `attachment; filename="community-approved.json"`)
	c.Data(http.StatusOK, "application/json; charset=utf-8", payload)
}

// GetPluginCatalogPublishRequests returns the recent publish history.
func GetPluginCatalogPublishRequests(c *gin.Context) {
	document, err := service.LoadPluginCatalog()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, document.PublishRequests)
}

// RequestPluginCatalogPublish records one release request and dispatches the configured webhook.
func RequestPluginCatalogPublish(c *gin.Context) {
	var body struct {
		Note string `json:"note"`
	}
	if c.Request.Body != nil {
		if err := common.DecodeJson(c.Request.Body, &body); err != nil {
			common.ApiErrorMsg(c, "请求体不是有效的 JSON")
			return
		}
	}
	document, err := service.RequestPluginCatalogPublish(c.GetString("username"), body.Note)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, document.PublishRequests)
}
