package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestFormatUserLogsStripsQuotaSaturation verifies the admin-only quota
// saturation marker (nested under other.admin_info) is removed for non-admin
// log views, since formatUserLogs strips the whole admin_info object.
func TestFormatUserLogsStripsQuotaSaturation(t *testing.T) {
	other := common.MapToJsonStr(map[string]interface{}{
		"model_price": 0.004,
		"admin_info": map[string]interface{}{
			"quota_saturation": map[string]interface{}{
				"op":      "QuotaFromDecimal",
				"kind":    "overflow",
				"clamped": common.MaxQuota,
			},
		},
	})
	logs := []*Log{{Other: other}}

	formatUserLogs(logs, 0)

	parsed, err := common.StrToMap(logs[0].Other)
	require.NoError(t, err)
	_, hasAdminInfo := parsed["admin_info"]
	require.False(t, hasAdminInfo, "admin_info (and nested quota_saturation) must be stripped for non-admin views")
	// Non-admin billing fields remain visible.
	require.Contains(t, parsed, "model_price")
}

func TestFormatUserLogsMasksSensitiveErrorContentAndChannelMetadata(t *testing.T) {
	logs := []*Log{
		{
			Type:    LogTypeError,
			Content: "status_code=403, 预扣费额度失败, 用户剩余额度: $133.371238, 需要预扣费额度: $200.302440",
			Other: common.MapToJsonStr(map[string]interface{}{
				"channel_id":   46,
				"channel_name": "oo-ccmax-claude",
				"channel_type": 14,
				"admin_info": map[string]interface{}{
					"use_channel": []string{"46"},
				},
			}),
		},
	}

	formatUserLogs(logs, 0)

	require.NotContains(t, logs[0].Content, "预扣费额度")
	require.NotContains(t, logs[0].Content, "$200.302440")
	require.Contains(t, logs[0].Content, "上游服务暂时不可用")

	parsed, err := common.StrToMap(logs[0].Other)
	require.NoError(t, err)
	assert.NotContains(t, parsed, "channel_id")
	assert.NotContains(t, parsed, "channel_name")
	assert.NotContains(t, parsed, "channel_type")
	assert.NotContains(t, parsed, "admin_info")
}
