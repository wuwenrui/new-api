package service

import (
	"net/url"
	"testing"

	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/stretchr/testify/require"
)

func TestBuildWebhookBodyUsesServerChanFormPayload(t *testing.T) {
	body, contentType, err := buildWebhookBody("https://sctapi.ftqq.com/SENDKEY.send", dto.Notify{
		Title:   "您的额度即将用尽",
		Content: "{{value}}，当前剩余额度为 {{value}}",
		Values:  []interface{}{"您的额度即将用尽", "450000"},
	})

	require.NoError(t, err)
	require.Equal(t, "application/x-www-form-urlencoded", contentType)

	values, err := url.ParseQuery(string(body))
	require.NoError(t, err)
	require.Equal(t, "您的额度即将用尽", values.Get("title"))
	require.Equal(t, "您的额度即将用尽，当前剩余额度为 450000", values.Get("desp"))
}

func TestBuildWebhookBodyReplacesGenericWebhookContentPlaceholders(t *testing.T) {
	body, contentType, err := buildWebhookBody("https://example.com/webhook", dto.Notify{
		Type:    dto.NotifyTypeQuotaExceed,
		Title:   "您的额度即将用尽",
		Content: "{{value}}，当前剩余额度为 {{value}}",
		Values:  []interface{}{"您的额度即将用尽", "450000"},
	})

	require.NoError(t, err)
	require.Equal(t, "application/json", contentType)
	require.Contains(t, string(body), `"content":"您的额度即将用尽，当前剩余额度为 450000"`)
}
