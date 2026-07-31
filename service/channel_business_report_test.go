package service

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/ratio_setting"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupChannelBusinessReportTestDB(t *testing.T) {
	t.Helper()
	originalDB := model.DB
	originalLogDB := model.LOG_DB
	originalQuotaPerUnit := common.QuotaPerUnit
	originalModelRatio := ratio_setting.ModelRatio2JSONString()
	originalCompletionRatio := ratio_setting.CompletionRatio2JSONString()
	originalGroupRatio := ratio_setting.GroupRatio2JSONString()

	common.OptionMapRWMutex.Lock()
	if common.OptionMap == nil {
		common.OptionMap = make(map[string]string)
	}
	originalProbeConfigs := common.OptionMap[UpstreamProbeConfigsOptionKey]
	common.OptionMap[UpstreamProbeConfigsOptionKey] = "[]"
	common.OptionMapRWMutex.Unlock()

	dbPath := filepath.Join(t.TempDir(), "channel-business-report.db")
	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(
		&model.Channel{},
		&model.Log{},
		&model.SystemTask{},
	))
	model.DB = db
	model.LOG_DB = db
	common.QuotaPerUnit = 500000
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":2.5}`))
	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"qwen3-vl-flash":0.2,"m-x":0.1}`))
	require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(`{"qwen3-vl-flash":2}`))

	t.Cleanup(func() {
		model.DB = originalDB
		model.LOG_DB = originalLogDB
		common.QuotaPerUnit = originalQuotaPerUnit
		require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(originalModelRatio))
		require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(originalCompletionRatio))
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(originalGroupRatio))
		common.OptionMapRWMutex.Lock()
		common.OptionMap[UpstreamProbeConfigsOptionKey] = originalProbeConfigs
		common.OptionMapRWMutex.Unlock()
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
	})
}

func seedBusinessChannel(t *testing.T, id int, name string, baseURL string, status int, balance float64, usedQuota int64, models string) {
	t.Helper()
	autoBan := 1
	priority := int64(0)
	weight := uint(0)
	require.NoError(t, model.DB.Create(&model.Channel{
		Id:          id,
		Type:        14,
		Key:         "redacted",
		Status:      status,
		Name:        name,
		Weight:      &weight,
		BaseURL:     &baseURL,
		Models:      models,
		Group:       "default",
		Priority:    &priority,
		AutoBan:     &autoBan,
		Balance:     balance,
		UsedQuota:   usedQuota,
		CreatedTime: 100,
	}).Error)
}

func seedBusinessConsumeLog(t *testing.T, channelID int, modelName string, createdAt int64, quota int, promptTokens int, completionTokens int) {
	t.Helper()
	require.NoError(t, model.LOG_DB.Create(&model.Log{
		CreatedAt:        createdAt,
		Type:             model.LogTypeConsume,
		Username:         "paying-user",
		ModelName:        modelName,
		Quota:            quota,
		PromptTokens:     promptTokens,
		CompletionTokens: completionTokens,
		ChannelId:        channelID,
		Group:            "default",
	}).Error)
}

func staticBusinessPackyPricing() func(context.Context) (packyPricingSnapshot, error) {
	return func(context.Context) (packyPricingSnapshot, error) {
		return packyPricingSnapshot{
			Models: map[string]packyPricingModel{
				"qwen3-vl-flash": {ModelRatio: 0.1, CompletionRatio: 2},
			},
			GroupRatios: map[string]float64{"bailian": 0.5},
		}, nil
	}
}

func noPreviousRows() []PACPriceMonitorRow { return nil }

// packy 渠道（名称映射上游分组 bailian）+ 无凭据渠道 + 停用渠道都应出现在报告里，
// 各自的成本可知性、收入、毛利与状态标记符合口径。
func TestBuildChannelBusinessReportCoreRows(t *testing.T) {
	setupChannelBusinessReportTestDB(t)
	inRange := time.Now().Unix() - 3600
	outOfRange := time.Now().Unix() - 40*86400

	seedBusinessChannel(t, 1, "pac-bai", "https://www.packyapi.com", common.ChannelStatusEnabled, 5.0, 1000000, "qwen3-vl-flash")
	seedBusinessChannel(t, 2, "other-upstream", "https://unknown.example", common.ChannelStatusEnabled, 50.0, 0, "m-x")
	seedBusinessChannel(t, 3, "disabled-one", "https://disabled.example", common.ChannelStatusManuallyDisabled, 100.0, 0, "m-x")

	seedBusinessConsumeLog(t, 1, "qwen3-vl-flash", inRange, 500000, 1000000, 500000)
	seedBusinessConsumeLog(t, 1, "qwen3-vl-flash", outOfRange, 999999, 0, 0) // 区间外不计
	seedBusinessConsumeLog(t, 2, "m-x", inRange, 250000, 100000, 0)

	report, err := BuildChannelBusinessReport(context.Background(), ChannelBusinessReportParams{
		Days:               30,
		FetchPackyPricing:  staticBusinessPackyPricing(),
		PreviousRowsLoader: noPreviousRows,
	})
	require.NoError(t, err)
	require.Equal(t, 30, report.Days)
	require.Len(t, report.Rows, 3)

	// 渠道 1：上游价已知，token 级成本精算
	row1 := report.Rows[0]
	require.Equal(t, 1, row1.ChannelID)
	assert.Equal(t, "bailian", row1.UpstreamGroup)
	assert.True(t, row1.CostKnown)
	assert.False(t, row1.CostPartial)
	assert.True(t, row1.LowBalance) // $5 < $10
	assert.InDelta(t, 2.0, row1.UsedQuotaUSD, 1e-9)
	assert.EqualValues(t, 1, row1.Requests)
	assert.InDelta(t, 1.0, row1.Revenue, 1e-9)
	assert.InDelta(t, 0.2, row1.EstimatedUpstreamCost, 1e-9) // (1M + 0.5M*2) * 0.1 * 0.5 / 500k
	assert.InDelta(t, 0.8, row1.GrossProfit, 1e-9)
	assert.InDelta(t, 80.0, row1.GrossMargin, 1e-9)

	require.Len(t, row1.TopModels, 1)
	model1 := row1.TopModels[0]
	assert.Equal(t, "qwen3-vl-flash", model1.ModelName)
	assert.True(t, model1.LocalPriceKnown)
	assert.InDelta(t, 1.0, model1.LocalInputPrice, 1e-9)  // 0.2 * 2.5 * 2
	assert.InDelta(t, 2.0, model1.LocalOutputPrice, 1e-9) // input * 2
	assert.True(t, model1.CostKnown)
	assert.InDelta(t, 0.1, model1.UpstreamInputPrice, 1e-9)  // 0.1 * 0.5 * 2
	assert.InDelta(t, 0.2, model1.UpstreamOutputPrice, 1e-9) // input * 2
	assert.InDelta(t, 1.0, model1.Revenue, 1e-9)
	assert.InDelta(t, 0.2, model1.EstimatedUpstreamCost, 1e-9)

	// 渠道 2：无凭据非 packy 上游——仍在报告中，成本标未知但收入照算
	row2 := report.Rows[1]
	require.Equal(t, 2, row2.ChannelID)
	assert.False(t, row2.CostKnown)
	assert.NotEmpty(t, row2.CostUnknownReason)
	assert.False(t, row2.LowBalance) // $50 >= $10
	assert.InDelta(t, 0.5, row2.Revenue, 1e-9)
	assert.Zero(t, row2.EstimatedUpstreamCost)
	require.Len(t, row2.TopModels, 1)
	assert.False(t, row2.TopModels[0].CostKnown)
	assert.NotEmpty(t, row2.TopModels[0].CostUnknownReason)
	assert.True(t, row2.TopModels[0].LocalPriceKnown) // 本地售价与上游无关

	// 渠道 3：停用渠道也出现，无用量
	row3 := report.Rows[2]
	require.Equal(t, 3, row3.ChannelID)
	assert.Equal(t, common.ChannelStatusManuallyDisabled, row3.Status)
	assert.Zero(t, row3.Requests)
	assert.Empty(t, row3.TopModels)
}

// 上游价与最近一次巡检基线不一致时，渠道和模型行都应标 price_changed。
func TestBuildChannelBusinessReportPriceChanged(t *testing.T) {
	setupChannelBusinessReportTestDB(t)
	inRange := time.Now().Unix() - 3600
	seedBusinessChannel(t, 1, "pac-bai", "https://www.packyapi.com", common.ChannelStatusEnabled, 100.0, 0, "qwen3-vl-flash")
	seedBusinessConsumeLog(t, 1, "qwen3-vl-flash", inRange, 500000, 1000000, 500000)

	report, err := BuildChannelBusinessReport(context.Background(), ChannelBusinessReportParams{
		Days:              30,
		FetchPackyPricing: staticBusinessPackyPricing(),
		PreviousRowsLoader: func() []PACPriceMonitorRow {
			return []PACPriceMonitorRow{{
				ChannelID:          1,
				ModelName:          "qwen3-vl-flash",
				UpstreamGroup:      "bailian",
				UpstreamInputPrice: 0.2, // 基线 0.2 vs 当前 0.1 → 变动
			}}
		},
	})
	require.NoError(t, err)
	require.Len(t, report.Rows, 1)
	assert.True(t, report.Rows[0].PriceChanged)
	require.Len(t, report.Rows[0].TopModels, 1)
	assert.True(t, report.Rows[0].TopModels[0].PriceChanged)
}

// Top 模型按收入降序、最多 5 个；模型缺上游价时渠道标 cost_partial。
func TestBuildChannelBusinessReportTopModelsLimitAndPartialCost(t *testing.T) {
	setupChannelBusinessReportTestDB(t)
	inRange := time.Now().Unix() - 3600
	seedBusinessChannel(t, 1, "pac-bai", "https://www.packyapi.com", common.ChannelStatusEnabled, 100.0, 0, "qwen3-vl-flash")
	// 6 个有收入的模型 + 1 个上游缺价的模型
	for i, name := range []string{"a1", "a2", "a3", "a4", "a5", "a6"} {
		seedBusinessConsumeLog(t, 1, name, inRange, 500000*(i+1), 0, 0)
	}
	seedBusinessConsumeLog(t, 1, "no-upstream-price", inRange, 700000, 0, 0)

	pricing := staticBusinessPackyPricing()
	report, err := BuildChannelBusinessReport(context.Background(), ChannelBusinessReportParams{
		Days: 30,
		FetchPackyPricing: func(ctx context.Context) (packyPricingSnapshot, error) {
			snapshot, err := pricing(ctx)
			if err != nil {
				return snapshot, err
			}
			// 给 a1..a6 上游价，唯独不给 no-upstream-price
			for _, name := range []string{"a1", "a2", "a3", "a4", "a5", "a6"} {
				snapshot.Models[name] = packyPricingModel{ModelRatio: 0.1, CompletionRatio: 1}
			}
			return snapshot, nil
		},
		PreviousRowsLoader: noPreviousRows,
	})
	require.NoError(t, err)
	require.Len(t, report.Rows, 1)
	row := report.Rows[0]

	assert.True(t, row.CostKnown)
	assert.True(t, row.CostPartial) // no-upstream-price 缺上游价
	require.Len(t, row.TopModels, channelBusinessTopModelsLimit)
	// 按收入降序：a6(3.0) > no-upstream-price? 不在 top 内也应验证排序
	for i := 0; i+1 < len(row.TopModels); i++ {
		assert.GreaterOrEqual(t, row.TopModels[i].Revenue, row.TopModels[i+1].Revenue)
	}
}

// days 参数归一化：非法值回退默认 30，超上限截断 90。
func TestBuildChannelBusinessReportDaysNormalization(t *testing.T) {
	setupChannelBusinessReportTestDB(t)

	report, err := BuildChannelBusinessReport(context.Background(), ChannelBusinessReportParams{
		Days:               -5,
		FetchPackyPricing:  staticBusinessPackyPricing(),
		PreviousRowsLoader: noPreviousRows,
	})
	require.NoError(t, err)
	assert.Equal(t, defaultChannelBusinessReportDays, report.Days)

	report, err = BuildChannelBusinessReport(context.Background(), ChannelBusinessReportParams{
		Days:               365,
		FetchPackyPricing:  staticBusinessPackyPricing(),
		PreviousRowsLoader: noPreviousRows,
	})
	require.NoError(t, err)
	assert.Equal(t, maxChannelBusinessReportDays, report.Days)
}
