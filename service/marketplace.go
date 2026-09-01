package service

import (
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const MaxMarketplaceArtifactBytes = 32 * 1024 * 1024

type MarketplacePublishInput struct {
	PluginKey      string
	PackageName    string
	DisplayName    string
	Description    string
	Category       string
	Visibility     string
	AuthorName     string
	Version        string
	MinHostVersion string
	MaxHostVersion string
	Platforms      []string
	Architectures  []string
	Permissions    []string
	Changelog      string
	Content        []byte
	DeclaredHash   string
	Signature      string
	SigningKeyID   string
	UserIDs        []int
}

type MarketplaceCatalogCategory struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

type MarketplaceCompatibility struct {
	MinHostVersion string   `json:"minHostVersion"`
	MaxHostVersion string   `json:"maxHostVersion,omitempty"`
	Platforms      []string `json:"platforms"`
	Architectures  []string `json:"architectures"`
}

type MarketplaceArtifact struct {
	URL       string `json:"url"`
	Format    string `json:"format"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
	KeyID     string `json:"keyId"`
	Signature string `json:"signature"`
	ExpiresAt string `json:"expiresAt"`
}

type MarketplaceCatalogItem struct {
	ID          string                   `json:"id"`
	Version     string                   `json:"version"`
	PackageName string                   `json:"packageName"`
	DisplayName string                   `json:"displayName"`
	Description string                   `json:"description,omitempty"`
	Category    string                   `json:"category"`
	Compat      MarketplaceCompatibility `json:"compat"`
	Permissions []string                 `json:"permissions"`
	Artifact    MarketplaceArtifact      `json:"artifact"`
}

type MarketplaceCatalog struct {
	SchemaVersion int                          `json:"schemaVersion"`
	Revision      string                       `json:"revision"`
	GeneratedAt   string                       `json:"generatedAt"`
	ExpiresAt     string                       `json:"expiresAt"`
	Categories    []MarketplaceCatalogCategory `json:"categories"`
	Plugins       []MarketplaceCatalogItem     `json:"plugins"`
}

func PublishMarketplacePlugin(input MarketplacePublishInput) (*model.MarketPlugin, error) {
	if input.Visibility != model.MarketPluginVisibilityPublic && input.Visibility != model.MarketPluginVisibilityPrivate {
		return nil, errors.New("插件可见状态无效")
	}
	if err := validateMarketplacePublishInput(input); err != nil {
		return nil, err
	}
	if len(input.Content) == 0 || len(input.Content) > MaxMarketplaceArtifactBytes {
		return nil, fmt.Errorf("插件制品大小必须在 1 到 %d 字节之间", MaxMarketplaceArtifactBytes)
	}
	contentHash := hex.EncodeToString(common.Sha256Raw(input.Content))
	if input.DeclaredHash != "" && input.DeclaredHash != contentHash {
		return nil, errors.New("插件制品 SHA-256 不匹配")
	}
	if err := verifyMarketplaceSignature(input, contentHash, int64(len(input.Content))); err != nil {
		return nil, err
	}
	platformsJSON, err := common.Marshal(input.Platforms)
	if err != nil {
		return nil, err
	}
	architecturesJSON, err := common.Marshal(input.Architectures)
	if err != nil {
		return nil, err
	}
	permissionsJSON, err := common.Marshal(input.Permissions)
	if err != nil {
		return nil, err
	}
	plugin := &model.MarketPlugin{
		PluginKey:     input.PluginKey,
		PackageName:   input.PackageName,
		DisplayName:   input.DisplayName,
		Description:   input.Description,
		Category:      input.Category,
		Visibility:    input.Visibility,
		AuthorName:    input.AuthorName,
		LatestVersion: input.Version,
	}
	artifact := &model.MarketPluginVersion{
		Version:           input.Version,
		PackageName:       input.PackageName,
		DisplayName:       input.DisplayName,
		Category:          input.Category,
		MinHostVersion:    input.MinHostVersion,
		MaxHostVersion:    input.MaxHostVersion,
		PlatformsJSON:     string(platformsJSON),
		ArchitecturesJSON: string(architecturesJSON),
		PermissionsJSON:   string(permissionsJSON),
		Changelog:         input.Changelog,
		Content:           input.Content,
		ContentHash:       contentHash,
		Signature:         input.Signature,
		SigningKeyID:      input.SigningKeyID,
		SizeBytes:         int64(len(input.Content)),
	}
	if err := model.PublishMarketPlugin(plugin, artifact, input.UserIDs); err != nil {
		return nil, err
	}
	return plugin, nil
}

func BuildMarketplaceCatalog(userID int, isAdmin bool, downloadBaseURL string) (*MarketplaceCatalog, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(downloadBaseURL), "/")
	if !strings.HasPrefix(baseURL, "https://") && !strings.HasPrefix(baseURL, "http://127.0.0.1") && !strings.HasPrefix(baseURL, "http://localhost") {
		return nil, errors.New("插件下载基础地址必须是 HTTPS 或回环地址")
	}
	plugins, err := model.ListVisibleMarketPlugins(userID, isAdmin)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	expires := now.Add(2 * time.Minute)
	generatedAt := formatMarketplaceTime(now)
	expiresAt := formatMarketplaceTime(expires)
	items := make([]MarketplaceCatalogItem, 0, len(plugins))
	categoryIDs := make(map[string]struct{})
	var revision int64
	for i := range plugins {
		plugin := &plugins[i]
		versions, err := model.ListMarketPluginVersions(plugin.Id)
		if err != nil {
			return nil, err
		}
		if len(versions) == 0 {
			continue
		}
		if plugin.UpdatedAt > revision {
			revision = plugin.UpdatedAt
		}
		for versionIndex := range versions {
			artifact := &versions[versionIndex]
			compatibility, permissions, err := decodeMarketplaceMetadata(artifact)
			if err != nil {
				return nil, err
			}
			categoryIDs[artifact.Category] = struct{}{}
			items = append(items, MarketplaceCatalogItem{
				ID:          plugin.PluginKey,
				Version:     artifact.Version,
				PackageName: artifact.PackageName,
				DisplayName: artifact.DisplayName,
				Description: plugin.Description,
				Category:    artifact.Category,
				Compat:      compatibility,
				Permissions: permissions,
				Artifact: MarketplaceArtifact{
					URL:       fmt.Sprintf("%s/api/marketplace/plugins/%s/versions/%s/download", baseURL, plugin.PluginKey, artifact.Version),
					Format:    "tgz",
					Size:      artifact.SizeBytes,
					SHA256:    artifact.ContentHash,
					KeyID:     artifact.SigningKeyID,
					Signature: artifact.Signature,
					ExpiresAt: expiresAt,
				},
			})
		}
	}
	categoryKeys := make([]string, 0, len(categoryIDs))
	for category := range categoryIDs {
		categoryKeys = append(categoryKeys, category)
	}
	sort.Strings(categoryKeys)
	categories := make([]MarketplaceCatalogCategory, 0, len(categoryKeys))
	for _, category := range categoryKeys {
		categories = append(categories, MarketplaceCatalogCategory{ID: category, DisplayName: marketplaceCategoryName(category)})
	}
	return &MarketplaceCatalog{
		SchemaVersion: 1,
		Revision:      fmt.Sprintf("%d", revision),
		GeneratedAt:   generatedAt,
		ExpiresAt:     expiresAt,
		Categories:    categories,
		Plugins:       items,
	}, nil
}

func decodeMarketplaceMetadata(artifact *model.MarketPluginVersion) (MarketplaceCompatibility, []string, error) {
	compatibility := MarketplaceCompatibility{
		MinHostVersion: artifact.MinHostVersion,
		MaxHostVersion: artifact.MaxHostVersion,
	}
	if err := common.UnmarshalJsonStr(artifact.PlatformsJSON, &compatibility.Platforms); err != nil {
		return MarketplaceCompatibility{}, nil, err
	}
	if err := common.UnmarshalJsonStr(artifact.ArchitecturesJSON, &compatibility.Architectures); err != nil {
		return MarketplaceCompatibility{}, nil, err
	}
	var permissions []string
	if err := common.UnmarshalJsonStr(artifact.PermissionsJSON, &permissions); err != nil {
		return MarketplaceCompatibility{}, nil, err
	}
	return compatibility, permissions, nil
}

func formatMarketplaceTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func marketplaceCategoryName(category string) string {
	switch category {
	case "office":
		return "办公与证据"
	case "legal":
		return "法律工作流"
	case "due-diligence":
		return "尽职调查"
	case "filing":
		return "立案"
	case "mediation":
		return "调解"
	default:
		return category
	}
}
