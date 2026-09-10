package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
)

// The plugin catalog registry is one operator-authored document, signed as a
// whole by the release publisher. It is stored as a file rather than a table
// because it has no per-user rows and is consumed wholesale by the publisher.
const (
	pluginCatalogDefaultPath     = "plugin-catalog.json"
	pluginCatalogCommunitySource = "https://awesome-dsh-plugin.com/plugins.json"
	pluginCatalogCacheTTL        = 10 * time.Minute
	pluginCatalogFetchTimeout    = 20 * time.Second
	pluginCatalogMaxBodyBytes    = 8 << 20
	pluginCatalogMaxTarballBytes = 64 << 20
)

var (
	pluginCatalogIDPattern      = regexp.MustCompile(`^[a-z][a-z0-9-]{0,79}$`)
	pluginCatalogOwnerPattern   = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`)
	pluginCatalogPackagePattern = regexp.MustCompile(`^(?:@[a-z0-9-]+/)?[a-z0-9][a-z0-9._-]*$`)
	pluginCatalogVersionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`)
	pluginCatalogSHA256Pattern  = regexp.MustCompile(`^[a-f0-9]{64}$`)
	// A repository-relative directory such as packages/lawyer-filing.
	pluginCatalogDirectoryPattern = regexp.MustCompile(`^[A-Za-z0-9._][A-Za-z0-9._/-]*$`)

	pluginCatalogMu      sync.Mutex
	pluginCatalogCacheMu sync.Mutex
	pluginCatalogCache   pluginCatalogCommunityCache
)

type pluginCatalogCommunityCache struct {
	entries   []pluginCatalogCommunityPlugin
	fetchedAt time.Time
}

// PluginCatalogTarball pins a community artifact the catalog will hand out.
type PluginCatalogTarball struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// PluginCatalogCommunityEntry is one community plugin this product opened.
type PluginCatalogCommunityEntry struct {
	ID          string                `json:"id"`
	Owner       string                `json:"owner"`
	Repo        string                `json:"repo"`
	PackageName string                `json:"packageName"`
	Version     string                `json:"version"`
	Category    string                `json:"category"`
	Enabled     bool                  `json:"enabled"`
	Tarball     *PluginCatalogTarball `json:"tarball,omitempty"`
}

// PluginCatalogOwnedEntry is one first-party plugin published by our release pipeline.
// Its fields mirror the operator list the publisher reads, so an entry exported
// from the admin page is what the release machine packs.
type PluginCatalogOwnedEntry struct {
	ID          string `json:"id"`
	Directory   string `json:"directory"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Category    string `json:"category"`
	Enabled     bool   `json:"enabled"`
}

// PluginCatalogPublishRequest records one operator-triggered release.
type PluginCatalogPublishRequest struct {
	ID          string `json:"id"`
	Revision    int64  `json:"revision"`
	RequestedAt int64  `json:"requestedAt"`
	RequestedBy string `json:"requestedBy"`
	Note        string `json:"note"`
	Status      string `json:"status"`
	Detail      string `json:"detail,omitempty"`
}

// PluginCatalogDocument is the whole registry file.
type PluginCatalogDocument struct {
	Revision        int64                         `json:"revision"`
	UpdatedAt       int64                         `json:"updatedAt"`
	UpdatedBy       string                        `json:"updatedBy"`
	Owned           []PluginCatalogOwnedEntry     `json:"owned"`
	Community       []PluginCatalogCommunityEntry `json:"community"`
	PublishRequests []PluginCatalogPublishRequest `json:"publishRequests"`
}

// PluginCatalogCommunityResult is one search hit from the upstream community catalog.
type PluginCatalogCommunityResult struct {
	Name          string `json:"name"`
	Owner         string `json:"owner"`
	Repo          string `json:"repo"`
	PackageName   string `json:"packageName"`
	Version       string `json:"version"`
	Category      string `json:"category"`
	Description   string `json:"description"`
	HasTarball    bool   `json:"hasTarball"`
	Deprecated    bool   `json:"deprecated"`
	AlreadyOpen   bool   `json:"alreadyOpen"`
	OpenVersion   string `json:"openVersion,omitempty"`
	OpenEnabled   bool   `json:"openEnabled,omitempty"`
	Compatibility string `json:"compatibility,omitempty"`
}

type pluginCatalogCommunityPlugin struct {
	Name        string            `json:"name"`
	Owner       string            `json:"owner"`
	URL         string            `json:"url"`
	NPM         string            `json:"npm"`
	Tarball     string            `json:"tarball"`
	Version     string            `json:"version"`
	Category    any               `json:"category"`
	Description map[string]string `json:"description"`
	Deprecated  bool              `json:"deprecated"`
}

type pluginCatalogCommunityDocument struct {
	Plugins []pluginCatalogCommunityPlugin `json:"plugins"`
}

// PluginCatalogPath returns the registry file location; PLUGIN_CATALOG_PATH overrides it.
func PluginCatalogPath() string {
	if configured := strings.TrimSpace(os.Getenv("PLUGIN_CATALOG_PATH")); configured != "" {
		return configured
	}
	return pluginCatalogDefaultPath
}

// LoadPluginCatalog reads the registry; a missing file is an empty registry.
func LoadPluginCatalog() (PluginCatalogDocument, error) {
	pluginCatalogMu.Lock()
	defer pluginCatalogMu.Unlock()
	return loadPluginCatalogLocked()
}

func loadPluginCatalogLocked() (PluginCatalogDocument, error) {
	document := PluginCatalogDocument{
		Owned:           []PluginCatalogOwnedEntry{},
		Community:       []PluginCatalogCommunityEntry{},
		PublishRequests: []PluginCatalogPublishRequest{},
	}
	raw, err := os.ReadFile(PluginCatalogPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return document, nil
		}
		return document, err
	}
	if len(raw) == 0 {
		return document, nil
	}
	if err := common.Unmarshal(raw, &document); err != nil {
		return document, fmt.Errorf("plugin catalog file is not valid JSON: %w", err)
	}
	if document.Owned == nil {
		document.Owned = []PluginCatalogOwnedEntry{}
	}
	if document.Community == nil {
		document.Community = []PluginCatalogCommunityEntry{}
	}
	if document.PublishRequests == nil {
		document.PublishRequests = []PluginCatalogPublishRequest{}
	}
	return document, nil
}

func savePluginCatalogLocked(document PluginCatalogDocument) error {
	raw, err := common.Marshal(document)
	if err != nil {
		return err
	}
	path := PluginCatalogPath()
	directory := filepath.Dir(path)
	if directory != "" && directory != "." {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			return err
		}
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

// ValidatePluginCatalogCommunityEntry rejects anything the signed catalog could not accept.
func ValidatePluginCatalogCommunityEntry(entry PluginCatalogCommunityEntry) (PluginCatalogCommunityEntry, error) {
	entry.ID = strings.TrimSpace(entry.ID)
	entry.Owner = strings.TrimSpace(entry.Owner)
	entry.PackageName = strings.TrimSpace(entry.PackageName)
	entry.Version = strings.TrimSpace(entry.Version)
	entry.Category = strings.TrimSpace(entry.Category)
	if !pluginCatalogIDPattern.MatchString(entry.ID) {
		return entry, errors.New("插件标识必须是 3–80 位小写字母、数字或连字符")
	}
	if !pluginCatalogOwnerPattern.MatchString(entry.Owner) {
		return entry, errors.New("仓库 owner 无效")
	}
	if !pluginCatalogPackagePattern.MatchString(entry.PackageName) {
		return entry, errors.New("npm 包名无效")
	}
	if strings.HasPrefix(entry.PackageName, "@deepseek-ai/") || strings.HasPrefix(entry.PackageName, "@lawyer-dsh/") {
		return entry, errors.New("社区插件不得使用产品包命名空间")
	}
	if !pluginCatalogVersionPattern.MatchString(entry.Version) {
		return entry, errors.New("版本必须是精确版本号，例如 1.2.3")
	}
	repo, err := url.Parse(strings.TrimSpace(entry.Repo))
	if err != nil || repo.Scheme != "https" || repo.Host != "github.com" || len(strings.Split(strings.Trim(repo.Path, "/"), "/")) != 2 {
		return entry, errors.New("仓库必须是 https://github.com/<owner>/<repo>")
	}
	entry.Repo = strings.TrimSuffix(repo.String(), "/")
	entry.Repo = strings.TrimSuffix(entry.Repo, ".git")
	if entry.Category == "" {
		entry.Category = "社区"
	}
	if entry.Tarball != nil {
		tarballURL, parseErr := url.Parse(strings.TrimSpace(entry.Tarball.URL))
		if parseErr != nil || tarballURL.Scheme != "https" {
			return entry, errors.New("社区制品地址必须是 HTTPS")
		}
		if !pluginCatalogSHA256Pattern.MatchString(entry.Tarball.SHA256) {
			return entry, errors.New("社区制品必须提供 64 位 sha256 摘要")
		}
		if entry.Tarball.Size <= 0 || entry.Tarball.Size > pluginCatalogMaxTarballBytes {
			return entry, errors.New("社区制品大小无效")
		}
		entry.Tarball.URL = tarballURL.String()
	}
	return entry, nil
}

// ValidatePluginCatalogOwnedEntry rejects anything the publisher could not pack.
func ValidatePluginCatalogOwnedEntry(entry PluginCatalogOwnedEntry) (PluginCatalogOwnedEntry, error) {
	entry.ID = strings.TrimSpace(entry.ID)
	entry.Directory = strings.TrimSpace(entry.Directory)
	entry.Name = strings.TrimSpace(entry.Name)
	entry.Description = strings.TrimSpace(entry.Description)
	entry.Category = strings.TrimSpace(entry.Category)
	if !pluginCatalogIDPattern.MatchString(entry.ID) {
		return entry, errors.New("插件标识必须是 3–80 位小写字母、数字或连字符")
	}
	if !pluginCatalogDirectoryPattern.MatchString(entry.Directory) || !safePluginCatalogDirectory(entry.Directory) {
		return entry, errors.New("插件目录必须是仓库内的相对路径，例如 packages/lawyer-filing")
	}
	if entry.Name == "" || len(entry.Name) > 120 {
		return entry, errors.New("插件名称不能为空且不超过 120 字节")
	}
	if entry.Description == "" || len(entry.Description) > 500 {
		return entry, errors.New("插件说明不能为空且不超过 500 字节")
	}
	if entry.Category == "" {
		entry.Category = "业务"
	}
	return entry, nil
}

// safePluginCatalogDirectory keeps the packed directory inside the repository.
func safePluginCatalogDirectory(directory string) bool {
	for _, segment := range strings.Split(directory, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return !strings.HasPrefix(directory, "/")
}

// UpsertPluginCatalogOwnedEntry adds or updates one first-party plugin.
func UpsertPluginCatalogOwnedEntry(entry PluginCatalogOwnedEntry, actor string) (PluginCatalogDocument, error) {
	validated, err := ValidatePluginCatalogOwnedEntry(entry)
	if err != nil {
		return PluginCatalogDocument{}, err
	}
	pluginCatalogMu.Lock()
	defer pluginCatalogMu.Unlock()
	document, err := loadPluginCatalogLocked()
	if err != nil {
		return document, err
	}
	replaced := false
	for index, existing := range document.Owned {
		if existing.ID == validated.ID || existing.Directory == validated.Directory {
			document.Owned[index] = validated
			replaced = true
			break
		}
	}
	if !replaced {
		document.Owned = append(document.Owned, validated)
	}
	sort.Slice(document.Owned, func(i, j int) bool { return document.Owned[i].ID < document.Owned[j].ID })
	document.Revision++
	document.UpdatedAt = time.Now().Unix()
	document.UpdatedBy = actor
	if err := savePluginCatalogLocked(document); err != nil {
		return document, err
	}
	return document, nil
}

// DeletePluginCatalogOwnedEntry removes one first-party plugin from the list.
func DeletePluginCatalogOwnedEntry(id string) (PluginCatalogDocument, error) {
	pluginCatalogMu.Lock()
	defer pluginCatalogMu.Unlock()
	document, err := loadPluginCatalogLocked()
	if err != nil {
		return document, err
	}
	kept := make([]PluginCatalogOwnedEntry, 0, len(document.Owned))
	found := false
	for _, entry := range document.Owned {
		if entry.ID == id {
			found = true
			continue
		}
		kept = append(kept, entry)
	}
	if !found {
		return document, fmt.Errorf("插件 %s 不在自有插件清单中", id)
	}
	document.Owned = kept
	document.Revision++
	document.UpdatedAt = time.Now().Unix()
	if err := savePluginCatalogLocked(document); err != nil {
		return document, err
	}
	return document, nil
}

// ExportPluginCatalogOwnedRegistry renders the operator list the publisher packs from.
func ExportPluginCatalogOwnedRegistry() ([]byte, error) {
	document, err := LoadPluginCatalog()
	if err != nil {
		return nil, err
	}
	return common.Marshal(document.Owned)
}

// UpsertPluginCatalogCommunityEntry opens or updates one community plugin.
func UpsertPluginCatalogCommunityEntry(entry PluginCatalogCommunityEntry, actor string) (PluginCatalogDocument, error) {
	validated, err := ValidatePluginCatalogCommunityEntry(entry)
	if err != nil {
		return PluginCatalogDocument{}, err
	}
	pluginCatalogMu.Lock()
	defer pluginCatalogMu.Unlock()
	document, err := loadPluginCatalogLocked()
	if err != nil {
		return document, err
	}
	replaced := false
	for index, existing := range document.Community {
		if existing.ID == validated.ID || existing.PackageName == validated.PackageName {
			document.Community[index] = validated
			replaced = true
			break
		}
	}
	if !replaced {
		document.Community = append(document.Community, validated)
	}
	sort.Slice(document.Community, func(i, j int) bool { return document.Community[i].ID < document.Community[j].ID })
	document.Revision++
	document.UpdatedAt = time.Now().Unix()
	document.UpdatedBy = actor
	if err := savePluginCatalogLocked(document); err != nil {
		return document, err
	}
	return document, nil
}

// DeletePluginCatalogCommunityEntry closes one community plugin.
func DeletePluginCatalogCommunityEntry(id string) (PluginCatalogDocument, error) {
	pluginCatalogMu.Lock()
	defer pluginCatalogMu.Unlock()
	document, err := loadPluginCatalogLocked()
	if err != nil {
		return document, err
	}
	kept := make([]PluginCatalogCommunityEntry, 0, len(document.Community))
	found := false
	for _, entry := range document.Community {
		if entry.ID == id {
			found = true
			continue
		}
		kept = append(kept, entry)
	}
	if !found {
		return document, fmt.Errorf("插件 %s 不在开放清单中", id)
	}
	document.Community = kept
	document.Revision++
	document.UpdatedAt = time.Now().Unix()
	if err := savePluginCatalogLocked(document); err != nil {
		return document, err
	}
	return document, nil
}

// ExportPluginCatalogRegistry renders the community allowlist the publisher consumes.
// Disabled entries stay in the file with their flag so the list stays reversible
// from the artifact itself; the publisher packs only enabled entries.
func ExportPluginCatalogRegistry() ([]byte, error) {
	document, err := LoadPluginCatalog()
	if err != nil {
		return nil, err
	}
	payload := struct {
		SchemaVersion int                           `json:"schemaVersion"`
		Source        string                        `json:"source"`
		UpdatedAt     string                        `json:"updatedAt"`
		Plugins       []PluginCatalogCommunityEntry `json:"plugins"`
	}{
		SchemaVersion: 1,
		Source:        pluginCatalogCommunitySource,
		UpdatedAt:     time.Unix(document.UpdatedAt, 0).UTC().Format("2006-01-02"),
		Plugins:       document.Community,
	}
	return common.Marshal(payload)
}

// SearchPluginCatalogCommunity queries the upstream community catalog.
func SearchPluginCatalogCommunity(query string) ([]PluginCatalogCommunityResult, error) {
	entries, err := pluginCatalogCommunityEntries()
	if err != nil {
		return nil, err
	}
	document, err := LoadPluginCatalog()
	if err != nil {
		return nil, err
	}
	openByRepo := map[string]PluginCatalogCommunityEntry{}
	openByPackage := map[string]PluginCatalogCommunityEntry{}
	for _, entry := range document.Community {
		openByRepo[normalizePluginCatalogRepo(entry.Repo)] = entry
		openByPackage[entry.PackageName] = entry
	}
	needle := strings.ToLower(strings.TrimSpace(query))
	results := make([]PluginCatalogCommunityResult, 0, 50)
	for _, entry := range entries {
		if entry.Deprecated {
			continue
		}
		if needle != "" && !pluginCatalogMatches(entry, needle) {
			continue
		}
		result := PluginCatalogCommunityResult{
			Name:        entry.Name,
			Owner:       entry.Owner,
			Repo:        entry.URL,
			PackageName: entry.NPM,
			Version:     entry.Version,
			Category:    pluginCatalogCategory(entry.Category),
			Description: pluginCatalogDescription(entry.Description),
			HasTarball:  strings.TrimSpace(entry.Tarball) != "",
		}
		if opened, ok := openByRepo[normalizePluginCatalogRepo(entry.URL)]; ok {
			result.AlreadyOpen = true
			result.OpenVersion = opened.Version
			result.OpenEnabled = opened.Enabled
		} else if entry.NPM != "" {
			if opened, ok := openByPackage[entry.NPM]; ok {
				result.AlreadyOpen = true
				result.OpenVersion = opened.Version
				result.OpenEnabled = opened.Enabled
			}
		}
		results = append(results, result)
		if len(results) >= 50 {
			break
		}
	}
	return results, nil
}

func pluginCatalogMatches(entry pluginCatalogCommunityPlugin, needle string) bool {
	// Descriptions are the only fields operators can search in Chinese, because
	// upstream names, owners and package names are all ASCII.
	for _, field := range []string{entry.Name, entry.Owner, entry.URL, entry.NPM, entry.Description["zh"], entry.Description["en"]} {
		if strings.Contains(strings.ToLower(field), needle) {
			return true
		}
	}
	return false
}

func normalizePluginCatalogRepo(value string) string {
	trimmed := strings.TrimSuffix(strings.TrimSpace(value), "/")
	trimmed = strings.TrimSuffix(trimmed, ".git")
	return strings.ToLower(trimmed)
}

func pluginCatalogCategory(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		for _, item := range typed {
			if text, ok := item.(string); ok && text != "" {
				return text
			}
		}
	}
	return "社区"
}

func pluginCatalogDescription(value map[string]string) string {
	if value == nil {
		return ""
	}
	if text := strings.TrimSpace(value["zh"]); text != "" {
		return text
	}
	return strings.TrimSpace(value["en"])
}

func pluginCatalogCommunityEntries() ([]pluginCatalogCommunityPlugin, error) {
	pluginCatalogCacheMu.Lock()
	defer pluginCatalogCacheMu.Unlock()
	if time.Since(pluginCatalogCache.fetchedAt) < pluginCatalogCacheTTL && pluginCatalogCache.entries != nil {
		return pluginCatalogCache.entries, nil
	}
	source := pluginCatalogCommunitySource
	if configured := strings.TrimSpace(os.Getenv("PLUGIN_CATALOG_COMMUNITY_URL")); configured != "" {
		source = configured
	}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, source, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("accept", "application/json")
	client := &http.Client{Timeout: pluginCatalogFetchTimeout}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("社区目录暂不可用：%w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("社区目录暂不可用（HTTP %d）", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, pluginCatalogMaxBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > pluginCatalogMaxBodyBytes {
		return nil, errors.New("社区目录超过大小限制")
	}
	var document pluginCatalogCommunityDocument
	if err := common.Unmarshal(raw, &document); err != nil {
		return nil, fmt.Errorf("社区目录不是有效 JSON：%w", err)
	}
	if document.Plugins == nil {
		return nil, errors.New("社区目录缺少插件列表")
	}
	pluginCatalogCache = pluginCatalogCommunityCache{entries: document.Plugins, fetchedAt: time.Now()}
	return document.Plugins, nil
}

// RequestPluginCatalogPublish records one release request and optionally dispatches a webhook.
func RequestPluginCatalogPublish(actor, note string) (PluginCatalogDocument, error) {
	pluginCatalogMu.Lock()
	document, err := loadPluginCatalogLocked()
	if err != nil {
		pluginCatalogMu.Unlock()
		return document, err
	}
	document.Revision++
	document.UpdatedAt = time.Now().Unix()
	document.UpdatedBy = actor
	request := PluginCatalogPublishRequest{
		ID:          fmt.Sprintf("pub-%d", time.Now().UnixNano()),
		Revision:    document.Revision,
		RequestedAt: time.Now().Unix(),
		RequestedBy: actor,
		Note:        strings.TrimSpace(note),
		Status:      "pending",
	}
	document.PublishRequests = append([]PluginCatalogPublishRequest{request}, document.PublishRequests...)
	if len(document.PublishRequests) > 50 {
		document.PublishRequests = document.PublishRequests[:50]
	}
	if err := savePluginCatalogLocked(document); err != nil {
		pluginCatalogMu.Unlock()
		return document, err
	}
	// The exporters take the same lock, so they must run after it is released.
	pluginCatalogMu.Unlock()
	owned, err := ExportPluginCatalogOwnedRegistry()
	if err != nil {
		return document, err
	}
	community, err := ExportPluginCatalogRegistry()
	if err != nil {
		return document, err
	}
	status, detail := dispatchPluginCatalogPublishWebhook(owned, community, request)
	pluginCatalogMu.Lock()
	defer pluginCatalogMu.Unlock()
	current, loadErr := loadPluginCatalogLocked()
	if loadErr != nil {
		return document, loadErr
	}
	for index, existing := range current.PublishRequests {
		if existing.ID == request.ID {
			current.PublishRequests[index].Status = status
			current.PublishRequests[index].Detail = detail
			break
		}
	}
	if err := savePluginCatalogLocked(current); err != nil {
		return current, err
	}
	return current, nil
}

func dispatchPluginCatalogPublishWebhook(owned []byte, community []byte, request PluginCatalogPublishRequest) (string, string) {
	target := strings.TrimSpace(os.Getenv("PLUGIN_CATALOG_PUBLISH_WEBHOOK"))
	if target == "" {
		return "pending", "未配置 PLUGIN_CATALOG_PUBLISH_WEBHOOK；请在发布机执行 publish-managed-catalog.mjs"
	}
	// The release machine needs both lists: the first-party operator list it
	// packs from, and the community allowlist it resolves into the same catalog.
	var ownedEntries []PluginCatalogOwnedEntry
	if err := common.Unmarshal(owned, &ownedEntries); err != nil {
		return "failed", err.Error()
	}
	var communityDocument any
	if err := common.Unmarshal(community, &communityDocument); err != nil {
		return "failed", err.Error()
	}
	body, err := common.Marshal(struct {
		Revision  int64                     `json:"revision"`
		Owned     []PluginCatalogOwnedEntry `json:"owned"`
		Community any                       `json:"community"`
	}{Revision: request.Revision, Owned: ownedEntries, Community: communityDocument})
	if err != nil {
		return "failed", err.Error()
	}
	httpRequest, err := http.NewRequestWithContext(context.Background(), http.MethodPost, target, strings.NewReader(string(body)))
	if err != nil {
		return "failed", err.Error()
	}
	httpRequest.Header.Set("content-type", "application/json")
	httpRequest.Header.Set("x-plugin-catalog-revision", fmt.Sprintf("%d", request.Revision))
	if token := strings.TrimSpace(os.Getenv("PLUGIN_CATALOG_PUBLISH_WEBHOOK_TOKEN")); token != "" {
		httpRequest.Header.Set("authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: pluginCatalogFetchTimeout}
	response, err := client.Do(httpRequest)
	if err != nil {
		return "failed", fmt.Sprintf("发布 webhook 调用失败：%v", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "failed", fmt.Sprintf("发布 webhook 返回 HTTP %d", response.StatusCode)
	}
	return "dispatched", "已提交发布任务"
}
