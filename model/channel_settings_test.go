package model

import (
	"testing"

	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestChannelValidateSettingsRejectsInvalidHTTPTransport(t *testing.T) {
	tests := []struct {
		name    string
		setting dto.ChannelSettings
		wantErr string
	}{
		{
			name:    "auto with shards is valid",
			setting: dto.ChannelSettings{HTTPProtocol: "auto", HTTP2ConnectionShards: 4},
		},
		{
			name:    "http1 with shards greater than one rejected",
			setting: dto.ChannelSettings{HTTPProtocol: "http1", HTTP2ConnectionShards: 2},
			wantErr: "http2_connection_shards",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			channel := &Channel{}
			channel.SetSetting(tt.setting)
			err := channel.ValidateSettings()
			if tt.wantErr == "" {
				require.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}

func TestAdvancedCustomChannelRequiresModelListRouteOnlyWhenUpdateChecksEnabled(t *testing.T) {
	inferenceRoute := dto.AdvancedCustomRoute{
		IncomingPath: "/v1/chat/completions",
		UpstreamPath: "/v1/chat/completions",
		Converter:    "none",
	}

	tests := []struct {
		name          string
		checksEnabled bool
		routes        []dto.AdvancedCustomRoute
		wantErr       string
	}{
		{
			name:   "legacy channel without discovery route remains valid",
			routes: []dto.AdvancedCustomRoute{inferenceRoute},
		},
		{
			name:          "enabled checks require discovery route",
			checksEnabled: true,
			routes:        []dto.AdvancedCustomRoute{inferenceRoute},
			wantErr:       dto.AdvancedCustomModelListPath,
		},
		{
			name:          "enabled checks accept discovery route",
			checksEnabled: true,
			routes: []dto.AdvancedCustomRoute{
				inferenceRoute,
				{
					IncomingPath: dto.AdvancedCustomModelListPath,
					UpstreamPath: dto.AdvancedCustomModelListPath,
					Converter:    "none",
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			channel := &Channel{Type: constant.ChannelTypeAdvancedCustom}
			channel.SetOtherSettings(dto.ChannelOtherSettings{
				UpstreamModelUpdateCheckEnabled: tt.checksEnabled,
				AdvancedCustom: &dto.AdvancedCustomConfig{
					Routes: tt.routes,
				},
			})

			err := channel.ValidateSettings()
			if tt.wantErr == "" {
				require.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantErr)
		})
	}
}

func modelPriceValue(value float64) *float64 {
	return &value
}

func TestChannelValidateSettingsNormalizesModelPrices(t *testing.T) {
	channel := &Channel{Models: "gpt-primary,gpt-backup"}
	channel.SetOtherSettings(dto.ChannelOtherSettings{
		PACUpstreamGroup: "  premium  ",
		ModelPrices: map[string]dto.ChannelModelPrice{
			"gpt-primary": {
				Input:      modelPriceValue(2),
				Output:     modelPriceValue(8),
				CacheRead:  modelPriceValue(0.2),
				CacheWrite: modelPriceValue(2.5),
			},
			"removed-model": {Input: modelPriceValue(99)},
		},
	})

	require.NoError(t, channel.ValidateSettings())

	settings := channel.GetOtherSettings()
	assert.Equal(t, "premium", settings.PACUpstreamGroup)
	require.Len(t, settings.ModelPrices, 1)
	assert.Equal(t, 2.0, *settings.ModelPrices["gpt-primary"].Input)
	_, exists := settings.ModelPrices["removed-model"]
	assert.False(t, exists)
}

func TestChannelValidateSettingsRejectsNegativeModelPrice(t *testing.T) {
	channel := &Channel{Models: "gpt-primary"}
	channel.SetOtherSettings(dto.ChannelOtherSettings{
		ModelPrices: map[string]dto.ChannelModelPrice{
			"gpt-primary": {
				Input:      modelPriceValue(-0.01),
				Output:     modelPriceValue(8),
				CacheRead:  modelPriceValue(0),
				CacheWrite: modelPriceValue(0),
			},
		},
	})

	err := channel.ValidateSettings()

	require.Error(t, err)
	assert.Contains(t, err.Error(), "gpt-primary")
	assert.Contains(t, err.Error(), "input")
}

func TestChannelValidateSettingsRejectsIncompleteModelPrice(t *testing.T) {
	channel := &Channel{Models: "gpt-primary"}
	channel.SetOtherSettings(dto.ChannelOtherSettings{
		ModelPrices: map[string]dto.ChannelModelPrice{
			"gpt-primary": {Input: modelPriceValue(2)},
		},
	})

	err := channel.ValidateSettings()

	require.Error(t, err)
	assert.Contains(t, err.Error(), "gpt-primary")
	assert.Contains(t, err.Error(), "output")
}

func TestChannelValidateSettingsAcceptsExplicitZeroModelPrices(t *testing.T) {
	channel := &Channel{Models: "free-model"}
	channel.SetOtherSettings(dto.ChannelOtherSettings{
		ModelPrices: map[string]dto.ChannelModelPrice{
			"free-model": {
				Input:      modelPriceValue(0),
				Output:     modelPriceValue(0),
				CacheRead:  modelPriceValue(0),
				CacheWrite: modelPriceValue(0),
			},
		},
	})

	require.NoError(t, channel.ValidateSettings())
}

func TestChannelValidateSettingsDropsPerCallModelPrices(t *testing.T) {
	originalModelPrices := ratio_setting.ModelPrice2JSONString()
	require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(`{"fixed-model":0.1}`))
	t.Cleanup(func() {
		require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(originalModelPrices))
	})
	channel := &Channel{Models: "fixed-model"}
	channel.SetOtherSettings(dto.ChannelOtherSettings{
		ModelPrices: map[string]dto.ChannelModelPrice{
			"fixed-model": {Input: modelPriceValue(1)},
		},
	})

	require.NoError(t, channel.ValidateSettings())
	assert.NotContains(t, channel.GetOtherSettings().ModelPrices, "fixed-model")
}
