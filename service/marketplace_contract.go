package service

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

const lawyerMarketplaceSigningKeyID = "lawyercopilot-market-2026"
const maxSafeJSONInteger uint64 = 9_007_199_254_740_991

const lawyerMarketplacePublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA7DhOCxFKBkFnD4TUG43Ij7CzpFF8gd5mbFti6b2IpYA=
-----END PUBLIC KEY-----`

var (
	marketIdentifierPattern        = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}$`)
	marketPackagePattern           = regexp.MustCompile(`^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$`)
	marketVersionPattern           = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)
	marketPermissionPattern        = regexp.MustCompile(`^[a-z][a-z0-9._-]*(?::[^[:space:]]{1,200})?$`)
	marketNumericIdentifierPattern = regexp.MustCompile(`^[0-9]+$`)
)

type marketplaceSignedArtifact struct {
	Format string `json:"format"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type marketplaceSignedCompatibility struct {
	Architectures  []string `json:"architectures"`
	MaxHostVersion string   `json:"maxHostVersion,omitempty"`
	MinHostVersion string   `json:"minHostVersion"`
	Platforms      []string `json:"platforms"`
}

type marketplaceSignedPayload struct {
	Artifact    marketplaceSignedArtifact      `json:"artifact"`
	Category    string                         `json:"category"`
	Compat      marketplaceSignedCompatibility `json:"compat"`
	DisplayName string                         `json:"displayName"`
	ID          string                         `json:"id"`
	PackageName string                         `json:"packageName"`
	Permissions []string                       `json:"permissions"`
	Version     string                         `json:"version"`
}

func validateMarketplacePublishInput(input MarketplacePublishInput) error {
	if !marketIdentifierPattern.MatchString(input.PluginKey) ||
		input.PluginKey == "constructor" || input.PluginKey == "prototype" {
		return errors.New("插件 ID 无效")
	}
	if !marketPackagePattern.MatchString(input.PackageName) {
		return errors.New("插件 npm 包名无效")
	}
	if input.DisplayName == "" || len(input.DisplayName) > 255 {
		return errors.New("插件显示名无效")
	}
	if !marketIdentifierPattern.MatchString(input.Category) {
		return errors.New("插件分类无效")
	}
	if err := validateMarketplaceSemver(input.Version); err != nil {
		return fmt.Errorf("插件版本必须是完整 SemVer: %w", err)
	}
	if err := validateMarketplaceSemver(input.MinHostVersion); err != nil {
		return fmt.Errorf("最低 Harness 版本必须是完整 SemVer: %w", err)
	}
	if input.MaxHostVersion != "" {
		if err := validateMarketplaceSemver(input.MaxHostVersion); err != nil {
			return fmt.Errorf("最高 Harness 版本必须是完整 SemVer: %w", err)
		}
		if compareMarketplaceSemver(input.MinHostVersion, input.MaxHostVersion) > 0 {
			return errors.New("最低 Harness 版本不得高于最高版本")
		}
	}
	if err := validateCanonicalList(input.Platforms, 16, marketIdentifierPattern, "平台"); err != nil {
		return err
	}
	if err := validateCanonicalList(input.Architectures, 16, marketIdentifierPattern, "架构"); err != nil {
		return err
	}
	if len(input.Permissions) > 0 {
		if err := validateCanonicalList(input.Permissions, 64, marketPermissionPattern, "权限"); err != nil {
			return err
		}
	}
	return nil
}

func validateMarketplaceSemver(value string) error {
	match := marketVersionPattern.FindStringSubmatch(value)
	if match == nil {
		return errors.New("格式无效")
	}
	for _, core := range match[1:4] {
		parsed, err := strconv.ParseUint(core, 10, 64)
		if err != nil || parsed > maxSafeJSONInteger {
			return errors.New("数值越界")
		}
	}
	if match[4] != "" {
		for _, identifier := range strings.Split(match[4], ".") {
			if !marketNumericIdentifierPattern.MatchString(identifier) {
				continue
			}
			if len(identifier) > 1 && strings.HasPrefix(identifier, "0") {
				return errors.New("prerelease 数值不得有前导零")
			}
			parsed, err := strconv.ParseUint(identifier, 10, 64)
			if err != nil || parsed > maxSafeJSONInteger {
				return errors.New("prerelease 数值越界")
			}
		}
	}
	return nil
}

func validateCanonicalList(values []string, limit int, pattern *regexp.Regexp, label string) error {
	if len(values) == 0 || len(values) > limit {
		return fmt.Errorf("插件%s数量必须在 1 到 %d 之间", label, limit)
	}
	previous := ""
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value != strings.TrimSpace(value) || !pattern.MatchString(value) {
			return fmt.Errorf("插件%s值无效: %q", label, value)
		}
		if _, exists := seen[value]; exists {
			return fmt.Errorf("插件%s不允许重复值: %s", label, value)
		}
		if previous != "" && previous > value {
			return fmt.Errorf("插件%s必须按字典序排列后签名", label)
		}
		seen[value] = struct{}{}
		previous = value
	}
	return nil
}

func canonicalJSONString(value string) string {
	var builder strings.Builder
	builder.WriteByte('"')
	for _, char := range value {
		switch char {
		case '"':
			builder.WriteString(`\"`)
		case '\\':
			builder.WriteString(`\\`)
		case '\b':
			builder.WriteString(`\b`)
		case '\f':
			builder.WriteString(`\f`)
		case '\n':
			builder.WriteString(`\n`)
		case '\r':
			builder.WriteString(`\r`)
		case '\t':
			builder.WriteString(`\t`)
		default:
			if char < 0x20 {
				builder.WriteString(fmt.Sprintf(`\u%04x`, char))
			} else {
				builder.WriteRune(char)
			}
		}
	}
	builder.WriteByte('"')
	return builder.String()
}

func canonicalStringArray(values []string) string {
	encoded := make([]string, len(values))
	for index, value := range values {
		encoded[index] = canonicalJSONString(value)
	}
	return "[" + strings.Join(encoded, ",") + "]"
}

func MarketplaceSignaturePayload(input MarketplacePublishInput, contentHash string, size int64) ([]byte, error) {
	compatibility := `{"architectures":` + canonicalStringArray(input.Architectures)
	if input.MaxHostVersion != "" {
		compatibility += `,"maxHostVersion":` + canonicalJSONString(input.MaxHostVersion)
	}
	compatibility += `,"minHostVersion":` + canonicalJSONString(input.MinHostVersion)
	compatibility += `,"platforms":` + canonicalStringArray(input.Platforms) + `}`
	payload := `{"artifact":{"format":"tgz","sha256":` + canonicalJSONString(contentHash)
	payload += `,"size":` + strconv.FormatInt(size, 10) + `}`
	payload += `,"category":` + canonicalJSONString(input.Category)
	payload += `,"compat":` + compatibility
	payload += `,"displayName":` + canonicalJSONString(input.DisplayName)
	payload += `,"id":` + canonicalJSONString(input.PluginKey)
	payload += `,"packageName":` + canonicalJSONString(input.PackageName)
	payload += `,"permissions":` + canonicalStringArray(input.Permissions)
	payload += `,"version":` + canonicalJSONString(input.Version) + `}`
	return []byte(payload), nil
}

func marketplaceSigningPublicKey(keyID string) (string, bool) {
	if configured := strings.TrimSpace(os.Getenv("MARKETPLACE_SIGNING_PUBLIC_KEYS")); configured != "" {
		var keys map[string]string
		if err := common.UnmarshalJsonStr(configured, &keys); err == nil {
			if key, ok := keys[keyID]; ok {
				return key, true
			}
		}
	}
	if keyID == lawyerMarketplaceSigningKeyID {
		return lawyerMarketplacePublicKey, true
	}
	return "", false
}

func verifyMarketplaceSignature(input MarketplacePublishInput, contentHash string, size int64) error {
	publicKeyPEM, trusted := marketplaceSigningPublicKey(input.SigningKeyID)
	if !trusted {
		return errors.New("插件签名 Key ID 未受信任")
	}
	signature, err := base64.StdEncoding.DecodeString(input.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return errors.New("插件 Ed25519 签名无效")
	}
	block, _ := pem.Decode([]byte(publicKeyPEM))
	if block == nil {
		return errors.New("插件签名公钥配置无效")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return fmt.Errorf("插件签名公钥配置无效: %w", err)
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return errors.New("插件签名公钥不是 Ed25519")
	}
	payload, err := MarketplaceSignaturePayload(input, contentHash, size)
	if err != nil {
		return err
	}
	if !ed25519.Verify(publicKey, payload, signature) {
		return errors.New("插件 Ed25519 签名与规范化元数据不匹配")
	}
	return nil
}

type parsedMarketplaceSemver struct {
	core       [3]uint64
	prerelease []string
}

func parseMarketplaceSemver(value string) parsedMarketplaceSemver {
	withoutBuild := strings.SplitN(value, "+", 2)[0]
	parts := strings.SplitN(withoutBuild, "-", 2)
	coreParts := strings.Split(parts[0], ".")
	parsed := parsedMarketplaceSemver{}
	for index := range 3 {
		parsed.core[index], _ = strconv.ParseUint(coreParts[index], 10, 64)
	}
	if len(parts) == 2 {
		parsed.prerelease = strings.Split(parts[1], ".")
	}
	return parsed
}

func compareMarketplaceSemver(left, right string) int {
	a := parseMarketplaceSemver(left)
	b := parseMarketplaceSemver(right)
	for index := range 3 {
		if a.core[index] < b.core[index] {
			return -1
		}
		if a.core[index] > b.core[index] {
			return 1
		}
	}
	if len(a.prerelease) == 0 || len(b.prerelease) == 0 {
		if len(a.prerelease) == len(b.prerelease) {
			return 0
		}
		if len(a.prerelease) == 0 {
			return 1
		}
		return -1
	}
	count := max(len(a.prerelease), len(b.prerelease))
	for index := range count {
		if index >= len(a.prerelease) {
			return -1
		}
		if index >= len(b.prerelease) {
			return 1
		}
		leftPart, leftErr := strconv.ParseUint(a.prerelease[index], 10, 64)
		rightPart, rightErr := strconv.ParseUint(b.prerelease[index], 10, 64)
		switch {
		case leftErr == nil && rightErr == nil:
			if leftPart < rightPart {
				return -1
			}
			if leftPart > rightPart {
				return 1
			}
		case leftErr == nil:
			return -1
		case rightErr == nil:
			return 1
		default:
			if a.prerelease[index] < b.prerelease[index] {
				return -1
			}
			if a.prerelease[index] > b.prerelease[index] {
				return 1
			}
		}
	}
	return 0
}
