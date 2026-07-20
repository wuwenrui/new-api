package service

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/ratio_setting"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupPACPriceMonitorTestDB(t *testing.T) {
	t.Helper()
	originalDB := model.DB
	originalLogDB := model.LOG_DB
	originalQuotaPerUnit := common.QuotaPerUnit
	originalModelRatio := ratio_setting.ModelRatio2JSONString()
	originalCompletionRatio := ratio_setting.CompletionRatio2JSONString()
	originalGroupRatio := ratio_setting.GroupRatio2JSONString()

	dbPath := filepath.Join(t.TempDir(), "pac-price-monitor.db")
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
	require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(`{"qwen3-vl-flash":2,"hy3":4}`))
	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"qwen3-vl-flash":0.2,"hy3":0.3,"missing-price":0.2}`))

	t.Cleanup(func() {
		model.DB = originalDB
		model.LOG_DB = originalLogDB
		common.QuotaPerUnit = originalQuotaPerUnit
		require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(originalModelRatio))
		require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(originalCompletionRatio))
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(originalGroupRatio))
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
	})
}

func seedPACMonitorChannel(t *testing.T, id int, name string, modelName string) {
	t.Helper()
	baseURL := "https://www.packyapi.com"
	autoBan := 1
	priority := int64(0)
	weight := uint(0)
	require.NoError(t, model.DB.Create(&model.Channel{
		Id:          id,
		Type:        14,
		Key:         "redacted",
		Status:      common.ChannelStatusEnabled,
		Name:        name,
		Weight:      &weight,
		BaseURL:     &baseURL,
		Models:      modelName,
		Group:       "default",
		Priority:    &priority,
		AutoBan:     &autoBan,
		CreatedTime: 100,
	}).Error)
}

func seedPACMonitorConsumeLog(t *testing.T, channelID int, modelName string, quota int, promptTokens int, completionTokens int) {
	t.Helper()
	require.NoError(t, model.LOG_DB.Create(&model.Log{
		CreatedAt:        1000,
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

func staticPackyPricing(models map[string]packyPricingModel, groupRatios map[string]float64) func(context.Context) (packyPricingSnapshot, error) {
	return func(context.Context) (packyPricingSnapshot, error) {
		return packyPricingSnapshot{
			Models:      models,
			GroupRatios: groupRatios,
		}, nil
	}
}

func TestBuildPACPriceMonitorReportComputesMarginAndUsage(t *testing.T) {
	setupPACPriceMonitorTestDB(t)
	seedPACMonitorChannel(t, 9, "pac-bai", "qwen3-vl-flash")
	seedPACMonitorConsumeLog(t, 9, "qwen3-vl-flash", 500000, 1000000, 0)

	report, err := BuildPACPriceMonitorReport(context.Background(), PACPriceMonitorParams{
		StartTimestamp: 900,
		EndTimestamp:   1100,
		TargetMargin:   60,
		FetchPricing: staticPackyPricing(map[string]packyPricingModel{
			"qwen3-vl-flash": {ModelRatio: 0.1, CompletionRatio: 2},
		}, map[string]float64{"bailian": 0.5}),
	})
	require.NoError(t, err)

	require.Equal(t, 1, report.Summary.CheckedModels)
	require.Equal(t, 0, report.Summary.RiskModels)
	require.Equal(t, 0, report.Summary.UnknownModels)
	require.Len(t, report.Rows, 1)
	row := report.Rows[0]
	require.Equal(t, "healthy", row.Status)
	require.Equal(t, "pac-bai", row.ChannelName)
	require.Equal(t, "qwen3-vl-flash", row.ModelName)
	require.Equal(t, "bailian", row.UpstreamGroup)
	requireFloatNear(t, 1.0, row.LocalInputPrice)
	requireFloatNear(t, 0.1, row.UpstreamInputPrice)
	requireFloatNear(t, 0.25, row.RecommendedInputPrice)
	requireFloatNear(t, 90.0, row.GrossMargin)
	requireFloatNear(t, 1.0, row.Revenue)
	requireFloatNear(t, 0.1, row.EstimatedUpstreamCost)
	requireFloatNear(t, 0.9, row.GrossProfit)
	requireFloatNear(t, 90.0, report.Summary.GrossMargin)
}

func TestBuildPACPriceMonitorReportMarksRiskAndUnknownRows(t *testing.T) {
	setupPACPriceMonitorTestDB(t)
	seedPACMonitorChannel(t, 16, "pac-hunyuan", "hy3")
	seedPACMonitorChannel(t, 18, "pac-custom", "missing-price")

	report, err := BuildPACPriceMonitorReport(context.Background(), PACPriceMonitorParams{
		TargetMargin: 60,
		FetchPricing: staticPackyPricing(map[string]packyPricingModel{
			"hy3": {ModelRatio: 0.5, CompletionRatio: 4},
		}, map[string]float64{"hunyuan-officially": 0.8}),
	})
	require.NoError(t, err)

	require.Equal(t, 2, report.Summary.CheckedModels)
	require.Equal(t, 1, report.Summary.RiskModels)
	require.Equal(t, 1, report.Summary.UnknownModels)
	require.Equal(t, "risk", report.Rows[0].Status)
	requireFloatNear(t, 2.0, report.Rows[0].RecommendedInputPrice)
	requireFloatNear(t, 8.0, report.Rows[0].RecommendedOutputPrice)
	require.Equal(t, "unknown", report.Rows[1].Status)
	require.Equal(t, "missing upstream group mapping", report.Rows[1].StatusReason)
}

func TestBuildPACPriceMonitorReportUsesLowerOutputMargin(t *testing.T) {
	setupPACPriceMonitorTestDB(t)
	seedPACMonitorChannel(t, 9, "pac-bai", "qwen3-vl-flash")

	report, err := BuildPACPriceMonitorReport(context.Background(), PACPriceMonitorParams{
		TargetMargin: 60,
		FetchPricing: staticPackyPricing(map[string]packyPricingModel{
			"qwen3-vl-flash": {ModelRatio: 0.1, CompletionRatio: 10},
		}, map[string]float64{"bailian": 0.5}),
	})
	require.NoError(t, err)

	require.Equal(t, 1, report.Summary.RiskModels)
	require.Equal(t, "risk", report.Rows[0].Status)
	requireFloatNear(t, 50.0, report.Rows[0].GrossMargin)
	requireFloatNear(t, 2.5, report.Rows[0].RecommendedOutputPrice)
}

func TestBuildPACPriceMonitorReportTreatsDisplayedTargetMarginAsHealthy(t *testing.T) {
	setupPACPriceMonitorTestDB(t)
	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"mimo-v2-pro":2.79999664}`))
	require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(`{"mimo-v2-pro":3}`))
	seedPACMonitorChannel(t, 19, "pac-mimo0.8", "mimo-v2-pro")

	report, err := BuildPACPriceMonitorReport(context.Background(), PACPriceMonitorParams{
		TargetMargin: 60,
		FetchPricing: staticPackyPricing(map[string]packyPricingModel{
			"mimo-v2-pro": {ModelRatio: 3.5, CompletionRatio: 3},
		}, map[string]float64{"mimo-officially": 0.8}),
	})
	require.NoError(t, err)

	require.Equal(t, 0, report.Summary.RiskModels)
	require.Len(t, report.Rows, 1)
	require.Equal(t, "healthy", report.Rows[0].Status)
	require.InDelta(t, 60.0, report.Rows[0].GrossMargin, 0.005)
}

func TestBuildPACPriceMonitorReportDetectsUpstreamPriceChange(t *testing.T) {
	setupPACPriceMonitorTestDB(t)
	seedPACMonitorChannel(t, 9, "pac-bai", "qwen3-vl-flash")

	report, err := BuildPACPriceMonitorReport(context.Background(), PACPriceMonitorParams{
		TargetMargin: 60,
		PreviousRows: []PACPriceMonitorRow{{
			ChannelID:           9,
			ModelName:           "qwen3-vl-flash",
			UpstreamGroup:       "bailian",
			UpstreamInputPrice:  0.08,
			UpstreamOutputPrice: 0.16,
		}},
		FetchPricing: staticPackyPricing(map[string]packyPricingModel{
			"qwen3-vl-flash": {ModelRatio: 0.1, CompletionRatio: 2},
		}, map[string]float64{"bailian": 0.5}),
	})
	require.NoError(t, err)

	require.Equal(t, 1, report.Summary.ChangedPrices)
	require.True(t, report.Summary.HasBaseline)
	require.Len(t, report.Rows, 1)
	require.True(t, report.Rows[0].PriceChanged)
	require.Equal(t, "changed", report.Rows[0].Status)
	require.Equal(t, "upstream price changed", report.Rows[0].StatusReason)
	subject, content := BuildPACPriceMonitorNotification(report)
	require.Equal(t, "PAC 价格巡检通知", subject)
	require.Contains(t, content, "上游价格变更 1 项")
}

func TestLoadLatestPACPriceMonitorReportUsesLatestSucceededRun(t *testing.T) {
	setupPACPriceMonitorTestDB(t)
	older := PACPriceMonitorReport{
		Rows: []PACPriceMonitorRow{{
			ChannelID:          9,
			ModelName:          "qwen3-vl-flash",
			UpstreamInputPrice: 0.08,
		}},
	}
	newerFailed := PACPriceMonitorReport{
		Rows: []PACPriceMonitorRow{{
			ChannelID:          9,
			ModelName:          "qwen3-vl-flash",
			UpstreamInputPrice: 0.2,
		}},
	}
	olderResult, err := common.Marshal(older)
	require.NoError(t, err)
	newerFailedResult, err := common.Marshal(newerFailed)
	require.NoError(t, err)
	require.NoError(t, model.DB.Create(&model.SystemTask{
		TaskID: "older-success",
		Type:   model.SystemTaskTypePACPriceMonitor,
		Status: model.SystemTaskStatusSucceeded,
		Result: string(olderResult),
	}).Error)
	require.NoError(t, model.DB.Create(&model.SystemTask{
		TaskID: "newer-failed",
		Type:   model.SystemTaskTypePACPriceMonitor,
		Status: model.SystemTaskStatusFailed,
		Result: string(newerFailedResult),
	}).Error)

	report, err := LoadLatestPACPriceMonitorReport()
	require.NoError(t, err)
	require.NotNil(t, report)
	require.Len(t, report.Rows, 1)
	requireFloatNear(t, 0.08, report.Rows[0].UpstreamInputPrice)
}

func TestBuildPACPriceMonitorReportWithLatestSnapshotComparesPreviousTask(t *testing.T) {
	setupPACPriceMonitorTestDB(t)
	seedPACMonitorChannel(t, 9, "pac-bai", "qwen3-vl-flash")
	previous := PACPriceMonitorReport{
		Rows: []PACPriceMonitorRow{{
			ChannelID:           9,
			ModelName:           "qwen3-vl-flash",
			UpstreamGroup:       "bailian",
			UpstreamInputPrice:  0.08,
			UpstreamOutputPrice: 0.16,
		}},
	}
	previousResult, err := common.Marshal(previous)
	require.NoError(t, err)
	require.NoError(t, model.DB.Create(&model.SystemTask{
		TaskID: "previous-success",
		Type:   model.SystemTaskTypePACPriceMonitor,
		Status: model.SystemTaskStatusSucceeded,
		Result: string(previousResult),
	}).Error)

	report, err := BuildPACPriceMonitorReportWithLatestSnapshot(context.Background(), PACPriceMonitorParams{
		TargetMargin: 60,
		FetchPricing: staticPackyPricing(map[string]packyPricingModel{
			"qwen3-vl-flash": {ModelRatio: 0.1, CompletionRatio: 2},
		}, map[string]float64{"bailian": 0.5}),
	})
	require.NoError(t, err)

	require.Equal(t, 1, report.Summary.ChangedPrices)
	require.True(t, report.Summary.HasBaseline)
	require.True(t, report.Rows[0].PriceChanged)
}

func TestBuildPACPriceMonitorNotificationIncludesHealthySummary(t *testing.T) {
	subject, content := BuildPACPriceMonitorNotification(PACPriceMonitorReport{
		Summary: PACPriceMonitorSummary{
			CheckedModels: 2,
			HasBaseline:   true,
			RiskModels:    0,
			UnknownModels: 0,
			ChangedPrices: 0,
			GrossMargin:   62.5,
		},
	})

	require.Equal(t, "PAC 价格巡检通知", subject)
	require.Contains(t, content, "上游价格未变")
	require.Contains(t, content, "毛利正常")
	require.Contains(t, content, "检测模型 2 个")
}

func TestBuildPACPriceMonitorNotificationReportsMissingBaseline(t *testing.T) {
	_, content := BuildPACPriceMonitorNotification(PACPriceMonitorReport{
		Summary: PACPriceMonitorSummary{
			CheckedModels: 2,
			HasBaseline:   false,
		},
	})

	require.Contains(t, content, "暂无历史价格基准")
}

// packyapi 渠道用公开定价，coderelay 类探测上游按 base_url 用探测定价，未配置的上游得到空快照。
func TestPickPACChannelPricingSelectsUpstreamByBase(t *testing.T) {
	packy := packyPricingSnapshot{Models: map[string]packyPricingModel{"m": {ModelRatio: 1}}}
	probeBase := "https://cdn.example.com"
	probe := map[string]packyPricingSnapshot{
		probeBase: {Models: map[string]packyPricingModel{"m": {ModelRatio: 5}}},
	}

	packyBase := "https://api.packyapi.com"
	packyCh := &model.Channel{Name: "pac-x", BaseURL: &packyBase}
	require.True(t, isPACPackyChannel(packyCh))
	require.EqualValues(t, 1, pickPACChannelPricing(packyCh, packy, probe).Models["m"].ModelRatio)

	upBase := probeBase
	upCh := &model.Channel{Name: "coderelay-max", BaseURL: &upBase}
	require.False(t, isPACPackyChannel(upCh))
	require.EqualValues(t, 5, pickPACChannelPricing(upCh, packy, probe).Models["m"].ModelRatio)

	otherBase := "https://unknown.example.com"
	otherCh := &model.Channel{Name: "coderelay-other", BaseURL: &otherBase}
	require.Empty(t, pickPACChannelPricing(otherCh, packy, probe).Models)
}

func TestUpstreamToPackySnapshotKeepsInputOutputRatios(t *testing.T) {
	out := upstreamToPackySnapshot(upstreamPricingSnapshot{
		GroupRatios: map[string]float64{"g": 0.3},
		Models:      map[string]upstreamPricingModel{"m": {ModelRatio: 5, CompletionRatio: 5, CacheRatio: 0.1, CreateCacheRatio: 1.25}},
	})
	require.InDelta(t, 0.3, out.GroupRatios["g"], 1e-9)
	require.InDelta(t, 5, out.Models["m"].ModelRatio, 1e-9)
	require.InDelta(t, 5, out.Models["m"].CompletionRatio, 1e-9)
}

// packyapi 定价获取失败时，报告应降级（不整体失败），packyapi 渠道标未知，其他上游不受影响。
func TestBuildPACPriceMonitorReportDegradesWhenPackyFails(t *testing.T) {
	setupPACPriceMonitorTestDB(t)
	seedPACMonitorChannel(t, 9, "pac-bai", "qwen3-vl-flash")

	report, err := BuildPACPriceMonitorReport(context.Background(), PACPriceMonitorParams{
		TargetMargin: 60,
		FetchPricing: func(context.Context) (packyPricingSnapshot, error) {
			return packyPricingSnapshot{}, errors.New("packy pricing status: 520")
		},
	})
	require.NoError(t, err)
	require.Len(t, report.Rows, 1)
	require.Equal(t, "unknown", report.Rows[0].Status)
	require.Equal(t, 1, report.Summary.UnknownModels)
}
