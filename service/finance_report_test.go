package service

import (
	"math"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupFinanceReportTestDB(t *testing.T) {
	t.Helper()
	originalDB := model.DB
	originalLogDB := model.LOG_DB
	originalQuotaPerUnit := common.QuotaPerUnit

	dbPath := filepath.Join(t.TempDir(), "finance-report.db")
	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(
		&model.Log{},
		&model.TopUp{},
		&model.SubscriptionOrder{},
		&model.User{},
	))
	model.DB = db
	model.LOG_DB = db
	common.QuotaPerUnit = 500000

	t.Cleanup(func() {
		model.DB = originalDB
		model.LOG_DB = originalLogDB
		common.QuotaPerUnit = originalQuotaPerUnit
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
	})
}

func requireFloatNear(t *testing.T, expected float64, actual float64) {
	t.Helper()
	if math.Abs(expected-actual) > 0.000001 {
		t.Fatalf("expected %.6f, got %.6f", expected, actual)
	}
}

func TestBuildFinanceReportAggregatesConsumptionAndCashIncome(t *testing.T) {
	setupFinanceReportTestDB(t)

	require.NoError(t, model.LOG_DB.Create(&model.Log{
		UserId:           1,
		Username:         "wyh",
		CreatedAt:        1100,
		Type:             model.LogTypeConsume,
		ModelName:        "deepseek-v4-flash",
		Quota:            1000000,
		PromptTokens:     1000,
		CompletionTokens: 100,
		Group:            "default",
		Other:            `{"group_ratio":2,"cache_tokens":100}`,
	}).Error)
	require.NoError(t, model.LOG_DB.Create(&model.Log{
		UserId:           1,
		Username:         "wyh",
		CreatedAt:        1200,
		Type:             model.LogTypeConsume,
		ModelName:        "qwen3-vl-flash",
		Quota:            300000,
		PromptTokens:     500,
		CompletionTokens: 50,
		Group:            "default",
		Other:            `{"group_ratio":3}`,
	}).Error)
	require.NoError(t, model.LOG_DB.Create(&model.Log{
		UserId:    1,
		Username:  "wyh",
		CreatedAt: 2100,
		Type:      model.LogTypeConsume,
		ModelName: "ignored-outside-range",
		Quota:     999999,
		Group:     "default",
		Other:     `{"group_ratio":2}`,
	}).Error)
	require.NoError(t, model.DB.Create(&model.TopUp{
		UserId:       1,
		Money:        10,
		TradeNo:      "topup-success",
		CompleteTime: 1300,
		Status:       common.TopUpStatusSuccess,
	}).Error)
	require.NoError(t, model.DB.Create(&model.TopUp{
		UserId:       1,
		Money:        88,
		TradeNo:      "topup-pending",
		CompleteTime: 1300,
		Status:       common.TopUpStatusPending,
	}).Error)
	require.NoError(t, model.DB.Create(&model.SubscriptionOrder{
		UserId:       1,
		Money:        20.5,
		TradeNo:      "sub-success",
		CompleteTime: 1400,
		Status:       common.TopUpStatusSuccess,
	}).Error)
	// 用户当前剩余额度合计 = 1000000 + 500000 = 1500000 quota -> 3.0 金额（与时间区间无关）
	require.NoError(t, model.DB.Create(&model.User{
		Username: "wyh",
		AffCode:  "aff-wyh",
		Quota:    1000000,
	}).Error)
	require.NoError(t, model.DB.Create(&model.User{
		Username: "idle-user",
		AffCode:  "aff-idle",
		Quota:    500000,
	}).Error)

	report, err := BuildFinanceReport(FinanceReportParams{
		StartTimestamp: 1000,
		EndTimestamp:   2000,
	})
	require.NoError(t, err)

	require.Equal(t, int64(2), report.Summary.Requests)
	require.Equal(t, int64(1300000), report.Summary.ConsumptionQuota)
	requireFloatNear(t, 2.6, report.Summary.ConsumptionAmount)
	requireFloatNear(t, 1.2, report.Summary.EstimatedUpstreamCost)
	requireFloatNear(t, 1.4, report.Summary.GrossProfit)
	requireFloatNear(t, 53.846153, report.Summary.GrossMargin)
	requireFloatNear(t, 10, report.Summary.CashTopUpAmount)
	requireFloatNear(t, 20.5, report.Summary.CashSubscriptionAmount)
	requireFloatNear(t, 30.5, report.Summary.CashIncomeAmount)
	requireFloatNear(t, 3, report.Summary.UserBalanceAmount)

	require.Len(t, report.Models, 2)
	require.Equal(t, "deepseek-v4-flash", report.Models[0].ModelName)
	requireFloatNear(t, 2, report.Models[0].ConsumptionAmount)
	requireFloatNear(t, 1, report.Models[0].EstimatedUpstreamCost)
	require.Equal(t, "qwen3-vl-flash", report.Models[1].ModelName)
	requireFloatNear(t, 0.6, report.Models[1].ConsumptionAmount)
	requireFloatNear(t, 0.2, report.Models[1].EstimatedUpstreamCost)

	require.Len(t, report.Users, 1)
	require.Equal(t, "wyh", report.Users[0].Username)
	requireFloatNear(t, 2.6, report.Users[0].ConsumptionAmount)
	requireFloatNear(t, 1.2, report.Users[0].EstimatedUpstreamCost)
}

func TestBuildFinanceReportFallsBackToOneForMissingOrInvalidGroupRatio(t *testing.T) {
	setupFinanceReportTestDB(t)

	for _, other := range []string{"", `{"group_ratio":0}`, `{"group_ratio":"bad"}`} {
		require.NoError(t, model.LOG_DB.Create(&model.Log{
			Username:  "wyh",
			CreatedAt: 1100,
			Type:      model.LogTypeConsume,
			ModelName: "fallback",
			Quota:     500000,
			Group:     "default",
			Other:     other,
		}).Error)
	}

	report, err := BuildFinanceReport(FinanceReportParams{
		StartTimestamp: 1000,
		EndTimestamp:   2000,
	})
	require.NoError(t, err)

	requireFloatNear(t, 3, report.Summary.ConsumptionAmount)
	requireFloatNear(t, 3, report.Summary.EstimatedUpstreamCost)
	requireFloatNear(t, 0, report.Summary.GrossProfit)
	requireFloatNear(t, 0, report.Summary.GrossMargin)
}
