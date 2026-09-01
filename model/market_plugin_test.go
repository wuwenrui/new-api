package model

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func prepareMarketPluginTest(t *testing.T) {
	t.Helper()
	require.NoError(t, DB.AutoMigrate(&User{}, &MarketPlugin{}, &MarketPluginVersion{}, &MarketPluginUserAccess{}))
	require.NoError(t, DB.Exec("DELETE FROM market_plugin_user_access").Error)
	require.NoError(t, DB.Exec("DELETE FROM market_plugin_versions").Error)
	require.NoError(t, DB.Exec("DELETE FROM market_plugins").Error)
	require.NoError(t, DB.Exec("DELETE FROM users").Error)
}

func TestMarketPluginVisibilityAndVersionAccess(t *testing.T) {
	prepareMarketPluginTest(t)
	user := User{Username: "market-reader", Password: "unused", Status: 1}
	require.NoError(t, DB.Create(&user).Error)
	public := MarketPlugin{PluginKey: "public-plugin", PackageName: "@lawyercopilot/public-plugin", DisplayName: "公开", Category: "general", Visibility: MarketPluginVisibilityPublic, LatestVersion: "1.0.0"}
	private := MarketPlugin{PluginKey: "private-plugin", PackageName: "@lawyercopilot/private-plugin", DisplayName: "私有", Category: "legal", Visibility: MarketPluginVisibilityPrivate, LatestVersion: "1.0.0"}
	require.NoError(t, DB.Create(&public).Error)
	require.NoError(t, DB.Create(&private).Error)
	require.NoError(t, DB.Create(&MarketPluginVersion{PluginID: public.Id, Version: "1.0.0", PackageName: public.PackageName, DisplayName: public.DisplayName, Category: public.Category, MinHostVersion: "0.1.2-alpha.1", MaxHostVersion: "0.1.2-alpha.1", PlatformsJSON: `["any"]`, ArchitecturesJSON: `["any"]`, PermissionsJSON: `[]`, Content: []byte("public"), ContentHash: "hash-public", Signature: "sig", SigningKeyID: "key", SizeBytes: 6}).Error)
	require.NoError(t, DB.Create(&MarketPluginVersion{PluginID: private.Id, Version: "1.0.0", PackageName: private.PackageName, DisplayName: private.DisplayName, Category: private.Category, MinHostVersion: "0.1.2-alpha.1", MaxHostVersion: "0.1.2-alpha.1", PlatformsJSON: `["any"]`, ArchitecturesJSON: `["any"]`, PermissionsJSON: `[]`, Content: []byte("private"), ContentHash: "hash-private", Signature: "sig", SigningKeyID: "key", SizeBytes: 7}).Error)
	require.NoError(t, replaceMarketPluginUserAccess(DB, private.Id, []int{user.Id}))

	visible, err := ListVisibleMarketPlugins(user.Id, false)
	require.NoError(t, err)
	require.Len(t, visible, 2)

	_, artifact, allowed, err := GetVisibleMarketPluginVersion("private-plugin", "1.0.0", user.Id, false)
	require.NoError(t, err)
	require.True(t, allowed)
	require.Equal(t, []byte("private"), artifact.Content)

	_, _, allowed, err = GetVisibleMarketPluginVersion("private-plugin", "1.0.0", user.Id+100, false)
	require.NoError(t, err)
	require.False(t, allowed)
}

func TestPublishMarketPluginRejectsDuplicateVersionWithoutReplacingArtifact(t *testing.T) {
	prepareMarketPluginTest(t)
	plugin := &MarketPlugin{PluginKey: "office", PackageName: "@lawyercopilot/office", DisplayName: "办公", Category: "office", Visibility: MarketPluginVisibilityPrivate, LatestVersion: "1.0.0"}
	version := &MarketPluginVersion{Version: "1.0.0", PackageName: plugin.PackageName, DisplayName: plugin.DisplayName, Category: plugin.Category, MinHostVersion: "0.1.2-alpha.1", MaxHostVersion: "0.1.2-alpha.1", PlatformsJSON: `["any"]`, ArchitecturesJSON: `["any"]`, PermissionsJSON: `[]`, Content: []byte("first"), ContentHash: "first", Signature: "sig", SigningKeyID: "key", SizeBytes: 5}
	require.NoError(t, PublishMarketPlugin(plugin, version, []int{7, 7, -1}))

	secondPlugin := &MarketPlugin{PluginKey: "office", PackageName: "@lawyercopilot/office", DisplayName: "办公2", Category: "office", Visibility: MarketPluginVisibilityPrivate, LatestVersion: "1.0.0"}
	secondVersion := &MarketPluginVersion{Version: "1.0.0", PackageName: secondPlugin.PackageName, DisplayName: secondPlugin.DisplayName, Category: secondPlugin.Category, MinHostVersion: "0.1.2-alpha.1", MaxHostVersion: "0.1.2-alpha.1", PlatformsJSON: `["any"]`, ArchitecturesJSON: `["any"]`, PermissionsJSON: `[]`, Content: []byte("second"), ContentHash: "second", Signature: "sig", SigningKeyID: "key", SizeBytes: 6}
	require.Error(t, PublishMarketPlugin(secondPlugin, secondVersion, []int{8}))

	stored, err := GetLatestMarketPluginVersion(plugin.Id, "1.0.0")
	require.NoError(t, err)
	require.Equal(t, []byte("first"), stored.Content)
	userIDs, err := GetMarketPluginUserIDs(plugin.Id)
	require.NoError(t, err)
	require.Equal(t, []int{7}, userIDs)
}
