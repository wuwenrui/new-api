package common

import (
	"testing"

	"github.com/QuantumNous/new-api/constant"
	"github.com/stretchr/testify/require"
)

func TestGetEndpointTypesByChannelTypeIncludesAnthropicForAliQwen(t *testing.T) {
	endpoints := GetEndpointTypesByChannelType(constant.ChannelTypeAli, "qwen3.5-plus")

	require.Equal(t, []constant.EndpointType{
		constant.EndpointTypeAnthropic,
		constant.EndpointTypeOpenAI,
	}, endpoints)
}

func TestGetEndpointTypesByChannelTypeKeepsOpenAIOnlyForUnsupportedAliModel(t *testing.T) {
	endpoints := GetEndpointTypesByChannelType(constant.ChannelTypeAli, "custom-text-model")

	require.Equal(t, []constant.EndpointType{constant.EndpointTypeOpenAI}, endpoints)
}

func TestGetEndpointTypesByChannelTypeIncludesImageGenerationForWan(t *testing.T) {
	endpoints := GetEndpointTypesByChannelType(constant.ChannelTypeAli, "wan2.7-image-pro")

	require.Equal(t, []constant.EndpointType{
		constant.EndpointTypeImageGeneration,
		constant.EndpointTypeOpenAI,
	}, endpoints)
}

func TestGetEndpointTypesByChannelTypeRejectsWanLookalikes(t *testing.T) {
	for _, modelName := range []string{"wan2.7-image", "foo-wan2.7-image-pro", "wan2.7-image-pro-edit", "wan2.7-image-pro-plus"} {
		t.Run(modelName, func(t *testing.T) {
			endpoints := GetEndpointTypesByChannelType(constant.ChannelTypeAli, modelName)
			require.Equal(t, []constant.EndpointType{constant.EndpointTypeOpenAI}, endpoints)
		})
	}
}

func TestSupportsAliAnthropicMessagesUsesConfiguredPatterns(t *testing.T) {
	t.Setenv(aliAnthropicMessagesModelsEnv, "custom-claude-compatible")

	require.True(t, SupportsAliAnthropicMessages("custom-claude-compatible-v1"))
	require.False(t, SupportsAliAnthropicMessages("qwen3.5-plus"))
}
