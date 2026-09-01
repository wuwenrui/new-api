package controller

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const maxMarketplacePublishBodyBytes = 48 * 1024 * 1024

type marketplacePublishRequest struct {
	PluginKey      string   `json:"plugin_id"`
	PackageName    string   `json:"package_name"`
	DisplayName    string   `json:"display_name"`
	Description    string   `json:"description"`
	Category       string   `json:"category"`
	Visibility     string   `json:"visibility"`
	AuthorName     string   `json:"author_name"`
	Version        string   `json:"version"`
	MinHostVersion string   `json:"min_host_version"`
	MaxHostVersion string   `json:"max_host_version"`
	Platforms      []string `json:"platforms"`
	Architectures  []string `json:"architectures"`
	Permissions    []string `json:"permissions"`
	Changelog      string   `json:"changelog"`
	ContentB64     string   `json:"content_b64"`
	ContentHash    string   `json:"sha256"`
	Signature      string   `json:"signature"`
	SigningKeyID   string   `json:"signing_key_id"`
	UserIDs        []int    `json:"user_ids"`
}

func GetMarketplaceCatalog(c *gin.Context) {
	catalog, err := service.BuildMarketplaceCatalog(
		c.GetInt("id"),
		c.GetInt("role") >= common.RoleAdminUser,
		system_setting.ServerAddress,
	)
	if err != nil {
		marketplaceError(c, http.StatusInternalServerError, "获取插件目录失败")
		return
	}
	c.JSON(http.StatusOK, catalog)
}

func DownloadMarketplacePlugin(c *gin.Context) {
	pluginKey := strings.TrimSpace(c.Param("id"))
	version := strings.TrimSpace(c.Param("version"))
	plugin, artifact, allowed, err := model.GetVisibleMarketPluginVersion(
		pluginKey,
		version,
		c.GetInt("id"),
		c.GetInt("role") >= common.RoleAdminUser,
	)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			marketplaceError(c, http.StatusNotFound, "插件或版本不存在")
			return
		}
		marketplaceError(c, http.StatusInternalServerError, "读取插件制品失败")
		return
	}
	if !allowed || artifact == nil {
		marketplaceError(c, http.StatusNotFound, "插件或版本不存在")
		return
	}
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", plugin.PluginKey+"-"+artifact.Version+".tgz"))
	c.Header("X-Artifact-SHA256", artifact.ContentHash)
	c.Header("X-Artifact-Signature", artifact.Signature)
	c.Header("X-Artifact-Signing-Key", artifact.SigningKeyID)
	c.Data(http.StatusOK, "application/gzip", artifact.Content)
}

func AdminPublishMarketplacePlugin(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxMarketplacePublishBodyBytes)
	var request marketplacePublishRequest
	if err := common.DecodeJsonStrict(c.Request.Body, &request); err != nil {
		marketplaceError(c, http.StatusBadRequest, "请求格式错误: "+err.Error())
		return
	}
	content, err := base64.StdEncoding.DecodeString(request.ContentB64)
	if err != nil {
		marketplaceError(c, http.StatusBadRequest, "插件制品 base64 无效")
		return
	}
	plugin, err := service.PublishMarketplacePlugin(service.MarketplacePublishInput{
		PluginKey:      strings.TrimSpace(request.PluginKey),
		PackageName:    strings.TrimSpace(request.PackageName),
		DisplayName:    strings.TrimSpace(request.DisplayName),
		Description:    strings.TrimSpace(request.Description),
		Category:       strings.TrimSpace(request.Category),
		Visibility:     request.Visibility,
		AuthorName:     strings.TrimSpace(request.AuthorName),
		Version:        strings.TrimSpace(request.Version),
		MinHostVersion: strings.TrimSpace(request.MinHostVersion),
		MaxHostVersion: strings.TrimSpace(request.MaxHostVersion),
		Platforms:      request.Platforms,
		Architectures:  request.Architectures,
		Permissions:    request.Permissions,
		Changelog:      request.Changelog,
		Content:        content,
		DeclaredHash:   strings.ToLower(strings.TrimSpace(request.ContentHash)),
		Signature:      strings.TrimSpace(request.Signature),
		SigningKeyID:   strings.TrimSpace(request.SigningKeyID),
		UserIDs:        request.UserIDs,
	})
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, gorm.ErrDuplicatedKey) || strings.Contains(strings.ToLower(err.Error()), "unique") {
			status = http.StatusConflict
		}
		marketplaceError(c, status, err.Error())
		return
	}
	userIDs, _ := model.GetMarketPluginUserIDs(plugin.Id)
	c.JSON(http.StatusCreated, gin.H{
		"id":             plugin.Id,
		"plugin_id":      plugin.PluginKey,
		"latest_version": plugin.LatestVersion,
		"user_ids":       userIDs,
	})
}

func AdminDeleteMarketplacePlugin(c *gin.Context) {
	pluginID, err := strconv.Atoi(c.Param("id"))
	if err != nil || pluginID <= 0 {
		marketplaceError(c, http.StatusBadRequest, "插件编号无效")
		return
	}
	if err := model.DeleteMarketPlugin(pluginID); err != nil {
		marketplaceError(c, http.StatusInternalServerError, "删除插件失败")
		return
	}
	c.Status(http.StatusNoContent)
}

func marketplaceError(c *gin.Context, status int, message string) {
	c.JSON(status, gin.H{"detail": message})
}
