package common

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	kitutil "github.com/QuantumNous/new-api/relaykit/relayconvert/kitutil"
	"strconv"
	"strings"
	"unsafe"

	"github.com/samber/lo"
)

const LocalLogContentLimit = 2048

// LocalLogPreview limits log-only content unless debug logging is enabled.
func LocalLogPreview(content string) string {
	if DebugEnabled || len(content) <= LocalLogContentLimit {
		return content
	}
	return fmt.Sprintf("%s... [truncated, original_length=%d, limit=%d]", content[:LocalLogContentLimit], len(content), LocalLogContentLimit)
}

func GetStringIfEmpty(str string, defaultValue string) string {
	if str == "" {
		return defaultValue
	}
	return str
}

func GetRandomString(length int) string {
	if length <= 0 {
		return ""
	}
	return lo.RandomString(length, lo.AlphanumericCharset)
}

func MapToJsonStr(m map[string]interface{}) string {
	bytes, err := json.Marshal(m)
	if err != nil {
		return ""
	}
	return string(bytes)
}

func StrToMap(str string) (map[string]interface{}, error) {
	m := make(map[string]interface{})
	err := Unmarshal([]byte(str), &m)
	if err != nil {
		return nil, err
	}
	return m, nil
}

func StrToJsonArray(str string) ([]interface{}, error) {
	var js []interface{}
	err := json.Unmarshal([]byte(str), &js)
	if err != nil {
		return nil, err
	}
	return js, nil
}

func IsJsonArray(str string) bool {
	var js []interface{}
	return json.Unmarshal([]byte(str), &js) == nil
}

func IsJsonObject(str string) bool {
	var js map[string]interface{}
	return json.Unmarshal([]byte(str), &js) == nil
}

func String2Int(str string) int {
	num, err := strconv.Atoi(str)
	if err != nil {
		return 0
	}
	return num
}

func StringsContains(strs []string, str string) bool {
	for _, s := range strs {
		if s == str {
			return true
		}
	}
	return false
}

// StringToByteSlice []byte only read, panic on append
func StringToByteSlice(s string) []byte {
	tmp1 := (*[2]uintptr)(unsafe.Pointer(&s))
	tmp2 := [3]uintptr{tmp1[0], tmp1[1], tmp1[1]}
	return *(*[]byte)(unsafe.Pointer(&tmp2))
}

func EncodeBase64(str string) string {
	return base64.StdEncoding.EncodeToString([]byte(str))
}

func GetJsonString(data any) string {
	if data == nil {
		return ""
	}
	b, _ := json.Marshal(data)
	return string(b)
}

// NormalizeBillingPreference resolves a user's billing preference.
//
// 产品规则：订阅仅用于解锁功能（plan.feature_keys），消费一律从钱包余额
// （users.quota）扣费，订阅永不作为扣费来源。历史支持 subscription_first /
// subscription_only / wallet_first 等模式，其中任何会回退到订阅扣费的模式，都会让
// 功能型订阅（plan.total_amount=0 语义为“不限量”）变成无限免费额度池，用户买了
// 功能包后消费不扣钱包。故统一归一到 wallet_only，从计费决策、读取、保存三个入口
// 一次堵死。如需恢复订阅扣费能力，改此处即可。
func NormalizeBillingPreference(_ string) string {
	return "wallet_only"
}

// MaskEmail masks a user email to prevent PII leakage in logs
// Returns "***masked***" if email is empty, otherwise shows only the domain part
func MaskEmail(email string) string {
	if email == "" {
		return "***masked***"
	}

	// Find the @ symbol
	atIndex := strings.Index(email, "@")
	if atIndex == -1 {
		// No @ symbol found, return masked
		return "***masked***"
	}

	// Return only the domain part with @ symbol
	return "***@" + email[atIndex+1:]
}

// MaskSensitiveInfo moved to the conversion kit (kitutil) because the types
// package error formatting depends on it; host callers keep this name.
func MaskSensitiveInfo(str string) string {
	return kitutil.MaskSensitiveInfo(str)
}

// sensitiveAccountPatterns match upstream/account error messages that must not
// be forwarded verbatim to end users. They can leak another account's balance
// or the internal pre-consumption estimate (which reveals upstream pricing).
var sensitiveAccountPatterns = []string{
	"预扣费额度",
	"需要预扣费额度",
	"insufficient balance",
	"insufficient quota",
	"pre-consum",
}

// ContainsSensitiveAccountInfo reports whether message contains text that
// should not be exposed to ordinary users.
func ContainsSensitiveAccountInfo(message string) bool {
	if message == "" {
		return false
	}
	lower := strings.ToLower(message)
	for _, pattern := range sensitiveAccountPatterns {
		if strings.Contains(lower, strings.ToLower(pattern)) {
			return true
		}
	}
	return false
}

// MaskSensitiveAccountInfo returns a generic user-safe message when the input
// exposes upstream account balance/pre-consumption details; otherwise it
// returns the input unchanged. Full details remain available to admin-only
// callers who do not run this sanitizer.
func MaskSensitiveAccountInfo(message string) string {
	if !ContainsSensitiveAccountInfo(message) {
		return message
	}
	return "上游服务暂时不可用，请稍后重试"
}
