package helper

import (
	"net/http"
	"net/http/httptest"
	"testing"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relaytypes "github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/QuantumNous/new-api/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// fullDayPeakWindows 覆盖一整天的三段窗口，保证任意运行时刻都落在高峰内，
// 便于在不注入时间的前提下端到端验证峰值系数确实乘入了计费。
const fullDayPeakWindows = `[{"start":"00:00","end":"12:00"},{"start":"12:00","end":"23:59"},{"start":"23:59","end":"00:01"}]`

func TestModelPriceHelper_PeakMultiplierAppliedToModelRatio(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// 保存并在结束时恢复模型倍率与峰谷配置，避免污染其他测试。
	savedModelRatio := ratio_setting.ModelRatio2JSONString()
	savedConfig := map[string]string{}
	require.NoError(t, config.GlobalConfig.SaveToDB(func(key, value string) error {
		savedConfig[key] = value
		return nil
	}))
	t.Cleanup(func() {
		require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(savedModelRatio))
		require.NoError(t, config.GlobalConfig.LoadFromDB(savedConfig))
		ratio_setting.ReloadPeakRatioFromSetting()
	})

	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"test-peak-model":10}`))
	require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{
		"peak_ratio_setting.enabled":    "true",
		"peak_ratio_setting.multiplier": "3",
		"peak_ratio_setting.timezone":   "Asia/Shanghai",
		"peak_ratio_setting.models":     `["test-peak-model"]`,
		"peak_ratio_setting.windows":    fullDayPeakWindows,
	}))
	ratio_setting.ReloadPeakRatioFromSetting()

	priceData := callModelPriceHelper(t, "test-peak-model")

	require.True(t, priceData.IsPeak, "should be in peak window")
	require.Equal(t, 3.0, priceData.PeakMultiplier)
	require.Equal(t, 10.0, priceData.BaseModelRatio)
	require.Equal(t, 30.0, priceData.ModelRatio, "model ratio must be base * multiplier during peak")
}

func TestModelPriceHelper_NoPeakWhenModelNotListed(t *testing.T) {
	gin.SetMode(gin.TestMode)

	savedModelRatio := ratio_setting.ModelRatio2JSONString()
	savedConfig := map[string]string{}
	require.NoError(t, config.GlobalConfig.SaveToDB(func(key, value string) error {
		savedConfig[key] = value
		return nil
	}))
	t.Cleanup(func() {
		require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(savedModelRatio))
		require.NoError(t, config.GlobalConfig.LoadFromDB(savedConfig))
		ratio_setting.ReloadPeakRatioFromSetting()
	})

	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"other-model":10}`))
	require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{
		"peak_ratio_setting.enabled":    "true",
		"peak_ratio_setting.multiplier": "3",
		"peak_ratio_setting.models":     `["test-peak-model"]`,
		"peak_ratio_setting.windows":    fullDayPeakWindows,
	}))
	ratio_setting.ReloadPeakRatioFromSetting()

	priceData := callModelPriceHelper(t, "other-model")

	require.False(t, priceData.IsPeak, "unlisted model must not be peak-priced")
	require.Equal(t, 10.0, priceData.ModelRatio, "unlisted model keeps base ratio")
}

func callModelPriceHelper(t *testing.T, modelName string) types.PriceData {
	t.Helper()
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("Content-Type", "application/json")
	ctx.Request = req
	ctx.Set("group", "default")

	info := &relaycommon.RelayInfo{
		OriginModelName: modelName,
		UserGroup:       "default",
		UsingGroup:      "default",
	}
	priceData, err := ModelPriceHelper(ctx, info, 1000, &relaytypes.TokenCountMeta{})
	require.NoError(t, err)
	return priceData
}
