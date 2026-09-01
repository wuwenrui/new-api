package model

import (
	"sort"

	"gorm.io/gorm"
)

const (
	MarketPluginVisibilityPublic  = "public"
	MarketPluginVisibilityPrivate = "private"
)

type MarketPlugin struct {
	Id            int    `json:"id" gorm:"primaryKey;autoIncrement"`
	PluginKey     string `json:"plugin_key" gorm:"size:128;uniqueIndex;not null"`
	PackageName   string `json:"package_name" gorm:"size:255;not null"`
	DisplayName   string `json:"display_name" gorm:"size:255;not null"`
	Description   string `json:"description" gorm:"type:text"`
	Category      string `json:"category" gorm:"size:64;not null;index"`
	Visibility    string `json:"visibility" gorm:"size:16;not null;index"`
	AuthorName    string `json:"author_name" gorm:"size:255"`
	LatestVersion string `json:"latest_version" gorm:"size:64;not null"`
	CreatedAt     int64  `json:"created_at" gorm:"autoCreateTime"`
	UpdatedAt     int64  `json:"updated_at" gorm:"autoUpdateTime"`
}

func (MarketPlugin) TableName() string {
	return "market_plugins"
}

type MarketPluginVersion struct {
	Id                int    `json:"id" gorm:"primaryKey;autoIncrement"`
	PluginID          int    `json:"plugin_id" gorm:"not null;uniqueIndex:idx_market_plugin_version;index"`
	Version           string `json:"version" gorm:"size:64;not null;uniqueIndex:idx_market_plugin_version"`
	PackageName       string `json:"package_name" gorm:"size:255;not null"`
	DisplayName       string `json:"display_name" gorm:"size:255;not null"`
	Category          string `json:"category" gorm:"size:64;not null;index"`
	MinHostVersion    string `json:"min_host_version" gorm:"size:64;not null;index"`
	MaxHostVersion    string `json:"max_host_version" gorm:"size:64"`
	PlatformsJSON     string `json:"platforms_json" gorm:"type:text;not null"`
	ArchitecturesJSON string `json:"architectures_json" gorm:"type:text;not null"`
	PermissionsJSON   string `json:"permissions_json" gorm:"type:text;not null"`
	Changelog         string `json:"changelog" gorm:"type:text"`
	Content           []byte `json:"-" gorm:"not null"`
	ContentHash       string `json:"content_hash" gorm:"size:64;not null"`
	Signature         string `json:"signature" gorm:"type:text;not null"`
	SigningKeyID      string `json:"signing_key_id" gorm:"size:128;not null"`
	SizeBytes         int64  `json:"size_bytes" gorm:"not null"`
	CreatedAt         int64  `json:"created_at" gorm:"autoCreateTime"`
}

func (MarketPluginVersion) TableName() string {
	return "market_plugin_versions"
}

type MarketPluginUserAccess struct {
	PluginID int `json:"plugin_id" gorm:"primaryKey;not null;index"`
	UserID   int `json:"user_id" gorm:"primaryKey;not null;index"`
}

func (MarketPluginUserAccess) TableName() string {
	return "market_plugin_user_access"
}

func PublishMarketPlugin(plugin *MarketPlugin, version *MarketPluginVersion, userIDs []int) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var current MarketPlugin
		err := tx.Where("plugin_key = ?", plugin.PluginKey).First(&current).Error
		switch err {
		case nil:
			plugin.Id = current.Id
			plugin.CreatedAt = current.CreatedAt
			if err := tx.Model(&current).Updates(map[string]any{
				"package_name":   plugin.PackageName,
				"display_name":   plugin.DisplayName,
				"description":    plugin.Description,
				"category":       plugin.Category,
				"visibility":     plugin.Visibility,
				"author_name":    plugin.AuthorName,
				"latest_version": plugin.LatestVersion,
			}).Error; err != nil {
				return err
			}
		case gorm.ErrRecordNotFound:
			if err := tx.Create(plugin).Error; err != nil {
				return err
			}
		default:
			return err
		}
		version.PluginID = plugin.Id
		if err := tx.Create(version).Error; err != nil {
			return err
		}
		return replaceMarketPluginUserAccess(tx, plugin.Id, userIDs)
	})
}

func DeleteMarketPlugin(pluginID int) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("plugin_id = ?", pluginID).Delete(&MarketPluginUserAccess{}).Error; err != nil {
			return err
		}
		if err := tx.Where("plugin_id = ?", pluginID).Delete(&MarketPluginVersion{}).Error; err != nil {
			return err
		}
		return tx.Delete(&MarketPlugin{}, pluginID).Error
	})
}

func ListVisibleMarketPlugins(userID int, isAdmin bool) ([]MarketPlugin, error) {
	var plugins []MarketPlugin
	query := DB.Model(&MarketPlugin{})
	if !isAdmin {
		accessibleIDs := DB.Model(&MarketPluginUserAccess{}).
			Select("plugin_id").
			Where("user_id = ?", userID)
		query = query.Where("visibility = ? OR id IN (?)", MarketPluginVisibilityPublic, accessibleIDs)
	}
	err := query.Order("category ASC, display_name ASC, id ASC").Find(&plugins).Error
	return plugins, err
}

func GetVisibleMarketPluginVersion(pluginKey, version string, userID int, isAdmin bool) (*MarketPlugin, *MarketPluginVersion, bool, error) {
	var plugin MarketPlugin
	if err := DB.Where("plugin_key = ?", pluginKey).First(&plugin).Error; err != nil {
		return nil, nil, false, err
	}
	allowed := isAdmin || plugin.Visibility == MarketPluginVisibilityPublic
	if !allowed {
		var count int64
		if err := DB.Model(&MarketPluginUserAccess{}).
			Where("plugin_id = ? AND user_id = ?", plugin.Id, userID).
			Count(&count).Error; err != nil {
			return nil, nil, false, err
		}
		allowed = count > 0
	}
	if !allowed {
		return &plugin, nil, false, nil
	}
	var artifact MarketPluginVersion
	if err := DB.Where("plugin_id = ? AND version = ?", plugin.Id, version).First(&artifact).Error; err != nil {
		return &plugin, nil, true, err
	}
	return &plugin, &artifact, true, nil
}

func ListMarketPluginVersions(pluginID int) ([]MarketPluginVersion, error) {
	var versions []MarketPluginVersion
	err := DB.Where("plugin_id = ?", pluginID).Order("created_at DESC, id DESC").Find(&versions).Error
	return versions, err
}

func GetLatestMarketPluginVersion(pluginID int, version string) (*MarketPluginVersion, error) {
	var artifact MarketPluginVersion
	err := DB.Where("plugin_id = ? AND version = ?", pluginID, version).First(&artifact).Error
	return &artifact, err
}

func GetMarketPluginUserIDs(pluginID int) ([]int, error) {
	var userIDs []int
	err := DB.Model(&MarketPluginUserAccess{}).
		Where("plugin_id = ?", pluginID).
		Pluck("user_id", &userIDs).Error
	sort.Ints(userIDs)
	return userIDs, err
}

// InitMarketplaceDB performs the additive marketplace migration at startup.
func InitMarketplaceDB() error {
	return DB.AutoMigrate(&MarketPlugin{}, &MarketPluginVersion{}, &MarketPluginUserAccess{})
}

func replaceMarketPluginUserAccess(tx *gorm.DB, pluginID int, userIDs []int) error {
	if err := tx.Where("plugin_id = ?", pluginID).Delete(&MarketPluginUserAccess{}).Error; err != nil {
		return err
	}
	seen := make(map[int]struct{}, len(userIDs))
	for _, userID := range userIDs {
		if userID <= 0 {
			continue
		}
		if _, exists := seen[userID]; exists {
			continue
		}
		seen[userID] = struct{}{}
		if err := tx.Create(&MarketPluginUserAccess{PluginID: pluginID, UserID: userID}).Error; err != nil {
			return err
		}
	}
	return nil
}
