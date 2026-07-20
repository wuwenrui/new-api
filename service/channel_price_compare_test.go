package service

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/ratio_setting"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupPriceCompareRatios(t *testing.T) {
	t.Helper()
	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"test-model":5}`))
	require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(`{"test-model":5}`))
	require.NoError(t, ratio_setting.UpdateCacheRatioByJSONString(`{"test-model":0.1}`))
	require.NoError(t, ratio_setting.UpdateCreateCacheRatioByJSONString(`{"test-model":1.25}`))
}

func newPriceCompareChannel() *model.Channel {
	priority := int64(100)
	return &model.Channel{Id: 7, Name: "coderelay-test", Priority: &priority}
}

func snapshotWithTestModel() upstreamPricingSnapshot {
	return upstreamPricingSnapshot{
		GroupRatios: map[string]float64{"grp": 0.3},
		Models: map[string]upstreamPricingModel{
			"test-model": {ModelRatio: 5, CompletionRatio: 5, CacheRatio: 0.1, CreateCacheRatio: 1.25},
		},
	}
}

// 本地分组倍率 2.5，上游分组倍率 0.3，模型倍率两侧一致：
// 本地 输入25/输出125/缓存读2.5/缓存写31.25；上游 输入3/输出15/缓存读0.3/缓存写3.75；盈利率均 88%。
func TestBuildChannelPriceCompareRowOK(t *testing.T) {
	setupPriceCompareRatios(t)
	row := buildChannelPriceCompareRow(newPriceCompareChannel(), "https://up.example", "grp", "test-model", snapshotWithTestModel(), 2.5)

	assert.Equal(t, "ok", row.Status)
	assert.Equal(t, int64(100), row.Priority)
	assert.Equal(t, "grp", row.UpstreamGroup)

	assert.InDelta(t, 25.0, row.LocalInput, 1e-9)
	assert.InDelta(t, 125.0, row.LocalOutput, 1e-9)
	assert.InDelta(t, 2.5, row.LocalCacheRead, 1e-9)
	assert.InDelta(t, 31.25, row.LocalCacheWrite, 1e-9)

	assert.InDelta(t, 3.0, row.UpstreamInput, 1e-9)
	assert.InDelta(t, 15.0, row.UpstreamOutput, 1e-9)
	assert.InDelta(t, 0.3, row.UpstreamCacheRead, 1e-9)
	assert.InDelta(t, 3.75, row.UpstreamCacheWrite, 1e-9)

	assert.InDelta(t, 88.0, row.MarginInput, 1e-9)
	assert.InDelta(t, 88.0, row.MarginOutput, 1e-9)
}

func TestBuildChannelPriceCompareRowUnknownBranches(t *testing.T) {
	setupPriceCompareRatios(t)
	snapshot := snapshotWithTestModel()

	// 未标注上游分组
	row := buildChannelPriceCompareRow(newPriceCompareChannel(), "https://up.example", "", "test-model", snapshot, 2.5)
	assert.Equal(t, "unknown", row.Status)
	assert.Contains(t, row.StatusReason, "上游分组")
	// 本地价仍应算出（用户售价与上游无关）
	assert.InDelta(t, 25.0, row.LocalInput, 1e-9)
	assert.Zero(t, row.UpstreamInput)

	// 上游无该分组倍率
	row = buildChannelPriceCompareRow(newPriceCompareChannel(), "https://up.example", "missing-grp", "test-model", snapshot, 2.5)
	assert.Equal(t, "unknown", row.Status)
	assert.Contains(t, row.StatusReason, "分组倍率")

	// 上游无该模型
	row = buildChannelPriceCompareRow(newPriceCompareChannel(), "https://up.example", "grp", "absent-model", snapshot, 2.5)
	assert.Equal(t, "unknown", row.Status)
	assert.Contains(t, row.StatusReason, "模型价格")
}

func TestLoadUpstreamProbeConfigs(t *testing.T) {
	common.OptionMapRWMutex.Lock()
	if common.OptionMap == nil {
		common.OptionMap = make(map[string]string)
	}
	common.OptionMap[UpstreamProbeConfigsOptionKey] = `[{"base_url":"https://cdn.example.com","access_token":"tok","user_id":"1"}]`
	common.OptionMapRWMutex.Unlock()

	configs, err := LoadUpstreamProbeConfigs()
	require.NoError(t, err)
	require.Len(t, configs, 1)
	assert.Equal(t, "https://cdn.example.com", configs[0].BaseURL)
	assert.Equal(t, "tok", configs[0].AccessToken)
	assert.Equal(t, "1", configs[0].UserID)

	common.OptionMapRWMutex.Lock()
	common.OptionMap[UpstreamProbeConfigsOptionKey] = "[]"
	common.OptionMapRWMutex.Unlock()
	configs, err = LoadUpstreamProbeConfigs()
	require.NoError(t, err)
	assert.Empty(t, configs)
}
