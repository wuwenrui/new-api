package ratio_setting

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDefaultModelOriginalPricesIncludeDiscountedModels(t *testing.T) {
	InitRatioSettings()

	expected := map[string]ModelOriginalPrice{
		"claude-fable-5":    {Input: 70, Output: 350},
		"claude-opus-4-6":   {Input: 35, Output: 175},
		"claude-opus-4-8":   {Input: 35, Output: 175},
		"claude-sonnet-4-6": {Input: 21, Output: 105},
		"claude-sonnet-5":   {Input: 14, Output: 70},
		"grok-4.5":          {Input: 14, Output: 42},
	}

	for model, expectedPrice := range expected {
		price, ok := GetModelOriginalPrice(model)
		require.True(t, ok, model)
		require.Equal(t, expectedPrice, price, model)
	}
}
