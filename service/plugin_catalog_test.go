package service

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// usePluginCatalogFile points the registry at a fresh temp file and returns it.
func usePluginCatalogFile(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "plugin-catalog.json")
	t.Setenv("PLUGIN_CATALOG_PATH", path)
	return path
}

func communityEntryFixture() PluginCatalogCommunityEntry {
	return PluginCatalogCommunityEntry{
		ID:          "lawyer-doc-review",
		Owner:       "wuwenrui",
		Repo:        "https://github.com/wuwenrui/dsh-plugin-doc-review",
		PackageName: "dsh-plugin-doc-review",
		Version:     "1.2.0",
		Category:    "法律",
		Enabled:     true,
	}
}

func TestLoadPluginCatalogMissingFileIsEmptyRegistry(t *testing.T) {
	usePluginCatalogFile(t)

	document, err := LoadPluginCatalog()

	require.NoError(t, err)
	assert.Equal(t, int64(0), document.Revision)
	assert.Empty(t, document.Owned)
	assert.Empty(t, document.Community)
	assert.Empty(t, document.PublishRequests)
}

func TestLoadPluginCatalogRejectsMalformedDocument(t *testing.T) {
	path := usePluginCatalogFile(t)
	require.NoError(t, os.WriteFile(path, []byte("{not json"), 0o600))

	_, err := LoadPluginCatalog()

	require.Error(t, err)
	assert.Contains(t, err.Error(), "plugin catalog file is not valid JSON")
}

func TestValidatePluginCatalogCommunityEntryRejectsInvalidEntries(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		mutate  func(entry *PluginCatalogCommunityEntry)
		wantErr string
	}{
		{
			name:    "invalid id",
			mutate:  func(entry *PluginCatalogCommunityEntry) { entry.ID = "9Bad ID" },
			wantErr: "插件标识",
		},
		{
			name:    "invalid owner",
			mutate:  func(entry *PluginCatalogCommunityEntry) { entry.Owner = "bad owner" },
			wantErr: "owner",
		},
		{
			name:    "invalid package name",
			mutate:  func(entry *PluginCatalogCommunityEntry) { entry.PackageName = "Bad Package" },
			wantErr: "npm 包名",
		},
		{
			name:    "product namespace",
			mutate:  func(entry *PluginCatalogCommunityEntry) { entry.PackageName = "@deepseek-ai/plugin" },
			wantErr: "产品包命名空间",
		},
		{
			name:    "range version",
			mutate:  func(entry *PluginCatalogCommunityEntry) { entry.Version = "^1.2.0" },
			wantErr: "版本",
		},
		{
			name:    "non github repo",
			mutate:  func(entry *PluginCatalogCommunityEntry) { entry.Repo = "https://gitlab.com/wuwenrui/dsh-plugin" },
			wantErr: "github.com",
		},
		{
			name: "insecure tarball",
			mutate: func(entry *PluginCatalogCommunityEntry) {
				entry.Tarball = &PluginCatalogTarball{URL: "http://example.com/a.tgz", SHA256: catalogTestSHA256, Size: 1024}
			},
			wantErr: "HTTPS",
		},
		{
			name: "tarball without digest",
			mutate: func(entry *PluginCatalogCommunityEntry) {
				entry.Tarball = &PluginCatalogTarball{URL: "https://example.com/a.tgz", Size: 1024}
			},
			wantErr: "sha256",
		},
		{
			name: "tarball without size",
			mutate: func(entry *PluginCatalogCommunityEntry) {
				entry.Tarball = &PluginCatalogTarball{URL: "https://example.com/a.tgz", SHA256: catalogTestSHA256}
			},
			wantErr: "大小",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			entry := communityEntryFixture()
			testCase.mutate(&entry)

			_, err := ValidatePluginCatalogCommunityEntry(entry)

			require.Error(t, err)
			assert.Contains(t, err.Error(), testCase.wantErr)
		})
	}
}

const catalogTestSHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

func TestUpsertPluginCatalogCommunityEntryPersistsAndBumpsRevision(t *testing.T) {
	path := usePluginCatalogFile(t)

	document, err := UpsertPluginCatalogCommunityEntry(communityEntryFixture(), "root")
	require.NoError(t, err)
	assert.Equal(t, int64(1), document.Revision)
	assert.Equal(t, "root", document.UpdatedBy)
	assert.NotZero(t, document.UpdatedAt)
	require.Len(t, document.Community, 1)
	assert.Equal(t, "lawyer-doc-review", document.Community[0].ID)

	reloaded, err := LoadPluginCatalog()
	require.NoError(t, err)
	require.Len(t, reloaded.Community, 1)
	assert.Equal(t, int64(1), reloaded.Revision)

	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Contains(t, string(raw), "lawyer-doc-review")
}

func TestUpsertPluginCatalogCommunityEntryReplacesSamePackage(t *testing.T) {
	usePluginCatalogFile(t)
	first := communityEntryFixture()
	_, err := UpsertPluginCatalogCommunityEntry(first, "root")
	require.NoError(t, err)

	updated := communityEntryFixture()
	updated.ID = "lawyer-doc-review-v2"
	updated.Version = "1.3.0"
	updated.Enabled = false
	document, err := UpsertPluginCatalogCommunityEntry(updated, "root")

	require.NoError(t, err)
	require.Len(t, document.Community, 1)
	assert.Equal(t, "lawyer-doc-review-v2", document.Community[0].ID)
	assert.Equal(t, "1.3.0", document.Community[0].Version)
	assert.False(t, document.Community[0].Enabled)
	assert.Equal(t, int64(2), document.Revision)
}

func TestUpsertPluginCatalogCommunityEntryKeepsEntriesSortedByID(t *testing.T) {
	usePluginCatalogFile(t)
	second := communityEntryFixture()
	second.ID = "alpha-plugin"
	second.PackageName = "alpha-plugin"
	second.Repo = "https://github.com/wuwenrui/alpha-plugin"
	first := communityEntryFixture()

	_, err := UpsertPluginCatalogCommunityEntry(second, "root")
	require.NoError(t, err)
	document, err := UpsertPluginCatalogCommunityEntry(first, "root")

	require.NoError(t, err)
	require.Len(t, document.Community, 2)
	assert.Equal(t, "alpha-plugin", document.Community[0].ID)
	assert.Equal(t, "lawyer-doc-review", document.Community[1].ID)
}

func TestDeletePluginCatalogCommunityEntryRemovesEntryAndRejectsUnknownID(t *testing.T) {
	usePluginCatalogFile(t)
	_, err := UpsertPluginCatalogCommunityEntry(communityEntryFixture(), "root")
	require.NoError(t, err)

	document, err := DeletePluginCatalogCommunityEntry("lawyer-doc-review")
	require.NoError(t, err)
	assert.Empty(t, document.Community)
	assert.Equal(t, int64(2), document.Revision)

	_, err = DeletePluginCatalogCommunityEntry("lawyer-doc-review")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "不在开放清单中")
}

func TestExportPluginCatalogRegistryKeepsDisabledEntriesFlagged(t *testing.T) {
	usePluginCatalogFile(t)
	enabled := communityEntryFixture()
	_, err := UpsertPluginCatalogCommunityEntry(enabled, "root")
	require.NoError(t, err)
	closed := communityEntryFixture()
	closed.ID = "closed-plugin"
	closed.PackageName = "closed-plugin"
	closed.Repo = "https://github.com/wuwenrui/closed-plugin"
	closed.Enabled = false
	_, err = UpsertPluginCatalogCommunityEntry(closed, "root")
	require.NoError(t, err)

	raw, err := ExportPluginCatalogRegistry()

	require.NoError(t, err)
	payload := string(raw)
	assert.Contains(t, payload, `"schemaVersion":1`)
	assert.Contains(t, payload, "lawyer-doc-review")
	// The publisher packs only enabled entries, but the artifact keeps the
	// disabled row so a withdrawal stays reversible from the file alone.
	var document struct {
		Plugins []PluginCatalogCommunityEntry `json:"plugins"`
	}
	require.NoError(t, common.Unmarshal(raw, &document))
	require.Len(t, document.Plugins, 2)
	for _, entry := range document.Plugins {
		if entry.ID == "closed-plugin" {
			assert.False(t, entry.Enabled)
		}
	}
}

func ownedEntryFixture() PluginCatalogOwnedEntry {
	return PluginCatalogOwnedEntry{
		ID:          "lawyer-contract",
		Directory:   "packages/lawyer-contract",
		Name:        "合同审稿",
		Description: "逐条风险清单与修改建议",
		Category:    "合同",
		Enabled:     true,
	}
}

func TestValidatePluginCatalogOwnedEntryRejectsInvalidEntries(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		mutate  func(entry *PluginCatalogOwnedEntry)
		wantErr string
	}{
		{
			name:    "invalid id",
			mutate:  func(entry *PluginCatalogOwnedEntry) { entry.ID = "9Bad ID" },
			wantErr: "插件标识",
		},
		{
			name:    "absolute directory",
			mutate:  func(entry *PluginCatalogOwnedEntry) { entry.Directory = "/etc/passwd" },
			wantErr: "插件目录",
		},
		{
			name:    "directory escaping the repository",
			mutate:  func(entry *PluginCatalogOwnedEntry) { entry.Directory = "packages/../../etc" },
			wantErr: "插件目录",
		},
		{
			name:    "empty name",
			mutate:  func(entry *PluginCatalogOwnedEntry) { entry.Name = "  " },
			wantErr: "插件名称",
		},
		{
			name:    "missing description",
			mutate:  func(entry *PluginCatalogOwnedEntry) { entry.Description = "" },
			wantErr: "插件说明",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			entry := ownedEntryFixture()
			testCase.mutate(&entry)

			_, err := ValidatePluginCatalogOwnedEntry(entry)

			require.Error(t, err)
			assert.Contains(t, err.Error(), testCase.wantErr)
		})
	}
}

func TestValidatePluginCatalogOwnedEntryDefaultsCategory(t *testing.T) {
	entry := ownedEntryFixture()
	entry.Category = "  "

	validated, err := ValidatePluginCatalogOwnedEntry(entry)

	require.NoError(t, err)
	assert.Equal(t, "业务", validated.Category)
}

func TestUpsertPluginCatalogOwnedEntryPersistsAndSorts(t *testing.T) {
	path := usePluginCatalogFile(t)
	second := ownedEntryFixture()
	second.ID = "lawyer-mediation"
	second.Directory = "packages/lawyer-mediation"
	first := ownedEntryFixture()

	_, err := UpsertPluginCatalogOwnedEntry(second, "root")
	require.NoError(t, err)
	document, err := UpsertPluginCatalogOwnedEntry(first, "root")

	require.NoError(t, err)
	require.Len(t, document.Owned, 2)
	assert.Equal(t, "lawyer-contract", document.Owned[0].ID)
	assert.Equal(t, int64(2), document.Revision)
	assert.Equal(t, "root", document.UpdatedBy)

	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Contains(t, string(raw), "packages/lawyer-contract")
}

func TestUpsertPluginCatalogOwnedEntryReplacesSameDirectory(t *testing.T) {
	usePluginCatalogFile(t)
	_, err := UpsertPluginCatalogOwnedEntry(ownedEntryFixture(), "root")
	require.NoError(t, err)

	renamed := ownedEntryFixture()
	renamed.ID = "lawyer-contract-review"
	renamed.Enabled = false
	document, err := UpsertPluginCatalogOwnedEntry(renamed, "root")

	require.NoError(t, err)
	require.Len(t, document.Owned, 1)
	assert.Equal(t, "lawyer-contract-review", document.Owned[0].ID)
	assert.False(t, document.Owned[0].Enabled)
}

func TestDeletePluginCatalogOwnedEntryRemovesEntryAndRejectsUnknownID(t *testing.T) {
	usePluginCatalogFile(t)
	_, err := UpsertPluginCatalogOwnedEntry(ownedEntryFixture(), "root")
	require.NoError(t, err)

	document, err := DeletePluginCatalogOwnedEntry("lawyer-contract")
	require.NoError(t, err)
	assert.Empty(t, document.Owned)

	_, err = DeletePluginCatalogOwnedEntry("lawyer-contract")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "不在自有插件清单中")
}

func TestExportPluginCatalogOwnedRegistryReturnsOperatorList(t *testing.T) {
	usePluginCatalogFile(t)
	_, err := UpsertPluginCatalogOwnedEntry(ownedEntryFixture(), "root")
	require.NoError(t, err)
	disabled := ownedEntryFixture()
	disabled.ID = "lawyer-legacy"
	disabled.Directory = "packages/lawyer-legacy"
	disabled.Enabled = false
	_, err = UpsertPluginCatalogOwnedEntry(disabled, "root")
	require.NoError(t, err)

	raw, err := ExportPluginCatalogOwnedRegistry()

	require.NoError(t, err)
	// The publisher requires a bare array, not a wrapper document.
	var entries []PluginCatalogOwnedEntry
	require.NoError(t, common.Unmarshal(raw, &entries))
	require.Len(t, entries, 2)
	assert.Equal(t, "packages/lawyer-contract", entries[0].Directory)
	assert.True(t, entries[0].Enabled)
	assert.False(t, entries[1].Enabled)
}

func TestRequestPluginCatalogPublishRecordsPendingRequest(t *testing.T) {
	usePluginCatalogFile(t)
	t.Setenv("PLUGIN_CATALOG_PUBLISH_WEBHOOK", "")
	_, err := UpsertPluginCatalogCommunityEntry(communityEntryFixture(), "root")
	require.NoError(t, err)

	document, err := RequestPluginCatalogPublish("root", "上架合同审阅插件")

	require.NoError(t, err)
	require.Len(t, document.PublishRequests, 1)
	request := document.PublishRequests[0]
	assert.Equal(t, "root", request.RequestedBy)
	assert.Equal(t, "上架合同审阅插件", request.Note)
	assert.Equal(t, "pending", request.Status)
	assert.Contains(t, request.Detail, "PLUGIN_CATALOG_PUBLISH_WEBHOOK")
	assert.Equal(t, int64(2), document.Revision)

	reloaded, err := LoadPluginCatalog()
	require.NoError(t, err)
	require.Len(t, reloaded.PublishRequests, 1)
	assert.Equal(t, request.ID, reloaded.PublishRequests[0].ID)
}
