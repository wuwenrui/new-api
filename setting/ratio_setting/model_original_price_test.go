package ratio_setting

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDefaultModelOriginalPriceIncludesFable5(t *testing.T) {
	InitRatioSettings()

	price, ok := GetModelOriginalPrice("claude-fable-5")

	require.True(t, ok)
	require.Equal(t, 70.0, price.Input)
	require.Equal(t, 350.0, price.Output)
}
