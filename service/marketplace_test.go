package service

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func prepareMarketplaceServiceTest(t *testing.T) {
	t.Helper()
	originalDB := model.DB
	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", t.Name())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.MarketPlugin{}, &model.MarketPluginVersion{}, &model.MarketPluginUserAccess{}))
	model.DB = db
	t.Cleanup(func() { model.DB = originalDB })
}

func signMarketplaceInput(t *testing.T, input *MarketplacePublishInput) {
	t.Helper()
	privateKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize))
	publicKey := privateKey.Public().(ed25519.PublicKey)
	der, err := x509.MarshalPKIXPublicKey(publicKey)
	require.NoError(t, err)
	keys, err := common.Marshal(map[string]string{
		"test-key": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})),
	})
	require.NoError(t, err)
	t.Setenv("MARKETPLACE_SIGNING_PUBLIC_KEYS", string(keys))
	input.SigningKeyID = "test-key"
	input.DeclaredHash = hex.EncodeToString(common.Sha256Raw(input.Content))
	payload, err := MarketplaceSignaturePayload(*input, input.DeclaredHash, int64(len(input.Content)))
	require.NoError(t, err)
	input.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
}

func marketplaceInput(version string, content []byte, userIDs []int) MarketplacePublishInput {
	return MarketplacePublishInput{
		PluginKey:      "lawyer-office",
		PackageName:    "@lawyercopilot/plugin-office",
		DisplayName:    "律师办公",
		Description:    "本地文档工具",
		Category:       "office",
		Visibility:     model.MarketPluginVisibilityPrivate,
		AuthorName:     "LawyerCopilot",
		Version:        version,
		MinHostVersion: "0.1.2-alpha.1",
		MaxHostVersion: "0.1.2-alpha.1",
		Platforms:      []string{"darwin", "win32"},
		Architectures:  []string{"arm64", "x64"},
		Permissions:    []string{"filesystem:workspace-read", "filesystem:workspace-write"},
		Changelog:      "测试版本",
		Content:        content,
		UserIDs:        userIDs,
	}
}

func TestPublishAndBuildMarketplaceCatalogIncludesAuthorizedHistory(t *testing.T) {
	prepareMarketplaceServiceTest(t)
	user := model.User{Username: "market-service-reader", Password: "unused", Status: common.UserStatusEnabled}
	require.NoError(t, model.DB.Create(&user).Error)
	oldInput := marketplaceInput("1.2.2", []byte("signed-plugin-v122"), []int{user.Id})
	oldInput.DisplayName = "旧名称"
	signMarketplaceInput(t, &oldInput)
	_, err := PublishMarketplacePlugin(oldInput)
	require.NoError(t, err)
	latestInput := marketplaceInput("1.2.3", []byte("signed-plugin-v123"), []int{user.Id})
	latestInput.DisplayName = "新名称"
	signMarketplaceInput(t, &latestInput)
	plugin, err := PublishMarketplacePlugin(latestInput)
	require.NoError(t, err)
	require.Equal(t, "1.2.3", plugin.LatestVersion)

	catalog, err := BuildMarketplaceCatalog(user.Id, false, "https://model.example.com")
	require.NoError(t, err)
	require.Len(t, catalog.Plugins, 2)
	require.ElementsMatch(t, []string{"1.2.2", "1.2.3"}, []string{catalog.Plugins[0].Version, catalog.Plugins[1].Version})
	for _, item := range catalog.Plugins {
		if item.Version == "1.2.2" {
			require.Equal(t, "旧名称", item.DisplayName)
		}
	}
	latest := catalog.Plugins[0]
	if latest.Version != "1.2.3" {
		latest = catalog.Plugins[1]
	}
	require.Equal(t, "lawyer-office", latest.ID)
	require.Equal(t, "@lawyercopilot/plugin-office", latest.PackageName)
	require.Equal(t, latestInput.DeclaredHash, latest.Artifact.SHA256)
	require.Equal(t, []string{"filesystem:workspace-read", "filesystem:workspace-write"}, latest.Permissions)
	require.Equal(t, "0.1.2-alpha.1", latest.Compat.MinHostVersion)
	require.Equal(t, "https://model.example.com/api/marketplace/plugins/lawyer-office/versions/1.2.3/download", latest.Artifact.URL)
	require.NotEmpty(t, catalog.GeneratedAt)
	require.NotEmpty(t, catalog.ExpiresAt)

	hidden, err := BuildMarketplaceCatalog(user.Id+100, false, "https://model.example.com")
	require.NoError(t, err)
	require.Empty(t, hidden.Plugins)
}

func TestPublishMarketplacePluginRejectsTamperingAndSchemaDrift(t *testing.T) {
	prepareMarketplaceServiceTest(t)
	valid := marketplaceInput("1.0.0", []byte("artifact"), nil)
	signMarketplaceInput(t, &valid)

	tamperedHash := valid
	tamperedHash.DeclaredHash = "deadbeef"
	_, err := PublishMarketplacePlugin(tamperedHash)
	require.ErrorContains(t, err, "SHA-256")

	tamperedSignature := valid
	tamperedSignature.DisplayName = "签名后被替换"
	_, err = PublishMarketplacePlugin(tamperedSignature)
	require.ErrorContains(t, err, "规范化元数据")

	invalidSignature := valid
	invalidSignature.Signature = "not-base64"
	_, err = PublishMarketplacePlugin(invalidSignature)
	require.ErrorContains(t, err, "Ed25519")

	invalidRange := valid
	invalidRange.MinHostVersion = "2.0.0"
	invalidRange.MaxHostVersion = "1.0.0"
	_, err = PublishMarketplacePlugin(invalidRange)
	require.ErrorContains(t, err, "不得高于")

	duplicatePermissions := valid
	duplicatePermissions.Permissions = []string{"filesystem:workspace-read", "filesystem:workspace-read"}
	_, err = PublishMarketplacePlugin(duplicatePermissions)
	require.ErrorContains(t, err, "重复")

	unsortedPlatforms := valid
	unsortedPlatforms.Platforms = []string{"win32", "darwin"}
	_, err = PublishMarketplacePlugin(unsortedPlatforms)
	require.ErrorContains(t, err, "字典序")

	leadingZeroPrerelease := valid
	leadingZeroPrerelease.Version = "1.0.0-01"
	_, err = PublishMarketplacePlugin(leadingZeroPrerelease)
	require.ErrorContains(t, err, "前导零")

	overflowVersion := valid
	overflowVersion.Version = "9007199254740992.0.0"
	_, err = PublishMarketplacePlugin(overflowVersion)
	require.ErrorContains(t, err, "数值越界")

	reservedID := valid
	reservedID.PluginKey = "constructor"
	_, err = PublishMarketplacePlugin(reservedID)
	require.ErrorContains(t, err, "插件 ID 无效")

	badPermission := valid
	badPermission.Permissions = []string{"filesystem:workspace-read", "INVALID PERMISSION"}
	_, err = PublishMarketplacePlugin(badPermission)
	require.ErrorContains(t, err, "权限值无效")
}

func TestProductionSigningKeyMatchesReleaseCanonicalPayload(t *testing.T) {
	t.Setenv("MARKETPLACE_SIGNING_PUBLIC_KEYS", "")
	input := MarketplacePublishInput{
		PluginKey:      "golden-plugin",
		PackageName:    "@lawyercopilot/golden-plugin",
		DisplayName:    "黄金插件",
		Category:       "legal",
		Version:        "1.0.0",
		MinHostVersion: "0.1.2-alpha.1",
		MaxHostVersion: "0.1.2-alpha.1",
		Platforms:      []string{"darwin", "win32"},
		Architectures:  []string{"arm64", "x64"},
		Permissions:    []string{"filesystem:workspace-read"},
		SigningKeyID:   lawyerMarketplaceSigningKeyID,
		Signature:      "bDD1nnd8zUvWouNekS0bQJRT9wldGl3l3fb5TqOESt2/PVW76HUUc/BKrRCPiL+uE0myvLgtUPWznMtIxl7MCA==",
	}
	payload, err := MarketplaceSignaturePayload(input, strings.Repeat("a", 64), 123)
	require.NoError(t, err)
	require.Equal(t, `{"artifact":{"format":"tgz","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":123},"category":"legal","compat":{"architectures":["arm64","x64"],"maxHostVersion":"0.1.2-alpha.1","minHostVersion":"0.1.2-alpha.1","platforms":["darwin","win32"]},"displayName":"黄金插件","id":"golden-plugin","packageName":"@lawyercopilot/golden-plugin","permissions":["filesystem:workspace-read"],"version":"1.0.0"}`, string(payload))
	require.NoError(t, verifyMarketplaceSignature(input, strings.Repeat("a", 64), 123))
}

func TestMarketplaceSignaturePayloadMatchesJavaScriptEscaping(t *testing.T) {
	input := MarketplacePublishInput{
		PluginKey:      "escape-plugin",
		PackageName:    "@lawyercopilot/escape-plugin",
		DisplayName:    "R&D <条文> \"\\\u2028\u2029",
		Category:       "legal",
		Version:        "1.0.0+build.1",
		MinHostVersion: "0.1.2-alpha.1",
		Platforms:      []string{"darwin"},
		Architectures:  []string{"arm64"},
		Permissions:    []string{},
	}
	payload, err := MarketplaceSignaturePayload(input, strings.Repeat("b", 64), 7)
	require.NoError(t, err)
	expected := "{\"artifact\":{\"format\":\"tgz\",\"sha256\":\"" + strings.Repeat("b", 64) + "\",\"size\":7},\"category\":\"legal\",\"compat\":{\"architectures\":[\"arm64\"],\"minHostVersion\":\"0.1.2-alpha.1\",\"platforms\":[\"darwin\"]},\"displayName\":\"R&D <条文> \\\"\\\\\u2028\u2029\",\"id\":\"escape-plugin\",\"packageName\":\"@lawyercopilot/escape-plugin\",\"permissions\":[],\"version\":\"1.0.0+build.1\"}"
	require.Equal(t, expected, string(payload))
	require.Contains(t, string(payload), "R&D <条文>")
	require.NotContains(t, string(payload), `\u0026`)
	require.NotContains(t, string(payload), `\u003c`)
}
