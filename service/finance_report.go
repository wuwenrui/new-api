package service

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"gorm.io/gorm"
)

type FinanceReportParams struct {
	StartTimestamp int64
	EndTimestamp   int64
	ModelName      string
	Username       string
	Group          string
	Channel        int
}

type FinanceReport struct {
	GeneratedAt    int64                   `json:"generated_at"`
	StartTimestamp int64                   `json:"start_timestamp"`
	EndTimestamp   int64                   `json:"end_timestamp"`
	Summary        FinanceReportSummary    `json:"summary"`
	Models         []FinanceReportModelRow `json:"models"`
	Users          []FinanceReportUserRow  `json:"users"`
}

type FinanceReportSummary struct {
	Requests               int64   `json:"requests"`
	ConsumptionQuota       int64   `json:"consumption_quota"`
	ConsumptionAmount      float64 `json:"consumption_amount"`
	EstimatedUpstreamCost  float64 `json:"estimated_upstream_cost"`
	GrossProfit            float64 `json:"gross_profit"`
	GrossMargin            float64 `json:"gross_margin"`
	CashTopUpAmount        float64 `json:"cash_topup_amount"`
	CashSubscriptionAmount float64 `json:"cash_subscription_amount"`
	CashIncomeAmount       float64 `json:"cash_income_amount"`
	UserBalanceAmount      float64 `json:"user_balance_amount"`
	PromptTokens           int64   `json:"prompt_tokens"`
	CompletionTokens       int64   `json:"completion_tokens"`
	CacheTokens            int64   `json:"cache_tokens"`
}

type FinanceReportModelRow struct {
	ModelName             string  `json:"model_name"`
	Requests              int64   `json:"requests"`
	ConsumptionQuota      int64   `json:"consumption_quota"`
	ConsumptionAmount     float64 `json:"consumption_amount"`
	EstimatedUpstreamCost float64 `json:"estimated_upstream_cost"`
	GrossProfit           float64 `json:"gross_profit"`
	GrossMargin           float64 `json:"gross_margin"`
	PromptTokens          int64   `json:"prompt_tokens"`
	CompletionTokens      int64   `json:"completion_tokens"`
	CacheTokens           int64   `json:"cache_tokens"`
}

type FinanceReportUserRow struct {
	Username              string  `json:"username"`
	Requests              int64   `json:"requests"`
	ConsumptionQuota      int64   `json:"consumption_quota"`
	ConsumptionAmount     float64 `json:"consumption_amount"`
	EstimatedUpstreamCost float64 `json:"estimated_upstream_cost"`
	GrossProfit           float64 `json:"gross_profit"`
	GrossMargin           float64 `json:"gross_margin"`
	PromptTokens          int64   `json:"prompt_tokens"`
	CompletionTokens      int64   `json:"completion_tokens"`
	CacheTokens           int64   `json:"cache_tokens"`
}

type financeAggregate struct {
	requests              int64
	consumptionQuota      int64
	consumptionAmount     float64
	estimatedUpstreamCost float64
	promptTokens          int64
	completionTokens      int64
	cacheTokens           int64
}

const financeReportExcludedUsername = "wuwenrui"

func BuildFinanceReport(params FinanceReportParams) (FinanceReport, error) {
	if common.QuotaPerUnit <= 0 {
		return FinanceReport{}, fmt.Errorf("quota per unit must be positive")
	}

	logs, err := loadFinanceLogs(params)
	if err != nil {
		return FinanceReport{}, err
	}

	summaryAgg := financeAggregate{}
	modelAggs := map[string]*financeAggregate{}
	userAggs := map[string]*financeAggregate{}

	for _, log := range logs {
		groupRatio, cacheTokens := financeLogRatios(log.Other)
		revenue := float64(log.Quota) / common.QuotaPerUnit
		cost := revenue / groupRatio

		addFinanceLog(&summaryAgg, log, revenue, cost, cacheTokens)

		modelKey := log.ModelName
		if modelKey == "" {
			modelKey = "(unknown)"
		}
		if _, ok := modelAggs[modelKey]; !ok {
			modelAggs[modelKey] = &financeAggregate{}
		}
		addFinanceLog(modelAggs[modelKey], log, revenue, cost, cacheTokens)

		userKey := log.Username
		if userKey == "" {
			userKey = "(unknown)"
		}
		if _, ok := userAggs[userKey]; !ok {
			userAggs[userKey] = &financeAggregate{}
		}
		addFinanceLog(userAggs[userKey], log, revenue, cost, cacheTokens)
	}

	cashTopUpAmount, err := sumFinanceCash("top_ups", params)
	if err != nil {
		return FinanceReport{}, err
	}
	cashSubscriptionAmount, err := sumFinanceCash("subscription_orders", params)
	if err != nil {
		return FinanceReport{}, err
	}

	// 可能退款：用户当前剩余余额合计（充值未使用的部分，随时可能退给用户）。
	// 这是当下快照，与所选时间区间无关。
	userBalanceAmount, err := sumUserBalance()
	if err != nil {
		return FinanceReport{}, err
	}

	summary := FinanceReportSummary{
		Requests:               summaryAgg.requests,
		ConsumptionQuota:       summaryAgg.consumptionQuota,
		ConsumptionAmount:      summaryAgg.consumptionAmount,
		EstimatedUpstreamCost:  summaryAgg.estimatedUpstreamCost,
		GrossProfit:            summaryAgg.consumptionAmount - summaryAgg.estimatedUpstreamCost,
		GrossMargin:            financeMargin(summaryAgg.consumptionAmount, summaryAgg.estimatedUpstreamCost),
		CashTopUpAmount:        cashTopUpAmount,
		CashSubscriptionAmount: cashSubscriptionAmount,
		CashIncomeAmount:       cashTopUpAmount + cashSubscriptionAmount,
		UserBalanceAmount:      userBalanceAmount,
		PromptTokens:           summaryAgg.promptTokens,
		CompletionTokens:       summaryAgg.completionTokens,
		CacheTokens:            summaryAgg.cacheTokens,
	}

	return FinanceReport{
		GeneratedAt:    time.Now().Unix(),
		StartTimestamp: params.StartTimestamp,
		EndTimestamp:   params.EndTimestamp,
		Summary:        summary,
		Models:         buildFinanceModelRows(modelAggs),
		Users:          buildFinanceUserRows(userAggs),
	}, nil
}

func loadFinanceLogs(params FinanceReportParams) ([]model.Log, error) {
	query := model.LOG_DB.Model(&model.Log{}).Where("type = ?", model.LogTypeConsume)
	query = query.Where("username <> ?", financeReportExcludedUsername)
	if params.StartTimestamp > 0 {
		query = query.Where("created_at >= ?", params.StartTimestamp)
	}
	if params.EndTimestamp > 0 {
		query = query.Where("created_at < ?", params.EndTimestamp)
	}
	if params.ModelName != "" {
		query = query.Where("model_name = ?", params.ModelName)
	}
	if params.Username != "" {
		query = query.Where("username = ?", params.Username)
	}
	if params.Channel > 0 {
		query = query.Where("channel_id = ?", params.Channel)
	}
	if params.Group != "" {
		query = query.Where(&model.Log{Group: params.Group})
	}

	var logs []model.Log
	err := query.Find(&logs).Error
	return logs, err
}

func financeReportExcludedUserIDs() *gorm.DB {
	return model.DB.Unscoped().
		Model(&model.User{}).
		Select("id").
		Where("username = ?", financeReportExcludedUsername)
}

func sumFinanceCash(table string, params FinanceReportParams) (float64, error) {
	query := model.DB.Table(table).
		Select("COALESCE(SUM(money), 0)").
		Where("status = ?", common.TopUpStatusSuccess).
		Where("user_id NOT IN (?)", financeReportExcludedUserIDs())
	if params.StartTimestamp > 0 {
		query = query.Where("complete_time >= ?", params.StartTimestamp)
	}
	if params.EndTimestamp > 0 {
		query = query.Where("complete_time < ?", params.EndTimestamp)
	}
	var total float64
	if err := query.Scan(&total).Error; err != nil {
		return 0, err
	}
	return total, nil
}

// sumUserBalance 汇总所有用户当前剩余额度，换算成金额，即「可能退款」敞口。
// 软删除用户由 GORM 默认作用域自动排除。
func sumUserBalance() (float64, error) {
	var totalQuota int64
	if err := model.DB.Model(&model.User{}).
		Select("COALESCE(SUM(quota), 0)").
		Where("username <> ?", financeReportExcludedUsername).
		Scan(&totalQuota).Error; err != nil {
		return 0, err
	}
	return float64(totalQuota) / common.QuotaPerUnit, nil
}

func financeLogRatios(other string) (float64, int64) {
	groupRatio := 1.0
	var cacheTokens int64
	trimmed := strings.TrimSpace(other)
	if trimmed == "" || !strings.HasPrefix(trimmed, "{") {
		return groupRatio, cacheTokens
	}

	var payload map[string]interface{}
	if err := common.UnmarshalJsonStr(trimmed, &payload); err != nil {
		return groupRatio, cacheTokens
	}
	if ratio, ok := financeFloat(payload["group_ratio"]); ok && ratio > 0 {
		groupRatio = ratio
	}
	if tokens, ok := financeFloat(payload["cache_tokens"]); ok && tokens > 0 {
		cacheTokens = int64(tokens)
	}
	return groupRatio, cacheTokens
}

func financeFloat(value interface{}) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case string:
		parsed, err := strconv.ParseFloat(v, 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func addFinanceLog(agg *financeAggregate, log model.Log, revenue float64, cost float64, cacheTokens int64) {
	agg.requests++
	agg.consumptionQuota += int64(log.Quota)
	agg.consumptionAmount += revenue
	agg.estimatedUpstreamCost += cost
	agg.promptTokens += int64(log.PromptTokens)
	agg.completionTokens += int64(log.CompletionTokens)
	agg.cacheTokens += cacheTokens
}

func financeMargin(revenue float64, cost float64) float64 {
	if revenue <= 0 {
		return 0
	}
	return (revenue - cost) / revenue * 100
}

func buildFinanceModelRows(aggs map[string]*financeAggregate) []FinanceReportModelRow {
	rows := make([]FinanceReportModelRow, 0, len(aggs))
	for modelName, agg := range aggs {
		rows = append(rows, FinanceReportModelRow{
			ModelName:             modelName,
			Requests:              agg.requests,
			ConsumptionQuota:      agg.consumptionQuota,
			ConsumptionAmount:     agg.consumptionAmount,
			EstimatedUpstreamCost: agg.estimatedUpstreamCost,
			GrossProfit:           agg.consumptionAmount - agg.estimatedUpstreamCost,
			GrossMargin:           financeMargin(agg.consumptionAmount, agg.estimatedUpstreamCost),
			PromptTokens:          agg.promptTokens,
			CompletionTokens:      agg.completionTokens,
			CacheTokens:           agg.cacheTokens,
		})
	}
	sort.Slice(rows, func(i int, j int) bool {
		return rows[i].ConsumptionAmount > rows[j].ConsumptionAmount
	})
	return rows
}

func buildFinanceUserRows(aggs map[string]*financeAggregate) []FinanceReportUserRow {
	rows := make([]FinanceReportUserRow, 0, len(aggs))
	for username, agg := range aggs {
		rows = append(rows, FinanceReportUserRow{
			Username:              username,
			Requests:              agg.requests,
			ConsumptionQuota:      agg.consumptionQuota,
			ConsumptionAmount:     agg.consumptionAmount,
			EstimatedUpstreamCost: agg.estimatedUpstreamCost,
			GrossProfit:           agg.consumptionAmount - agg.estimatedUpstreamCost,
			GrossMargin:           financeMargin(agg.consumptionAmount, agg.estimatedUpstreamCost),
			PromptTokens:          agg.promptTokens,
			CompletionTokens:      agg.completionTokens,
			CacheTokens:           agg.cacheTokens,
		})
	}
	sort.Slice(rows, func(i int, j int) bool {
		return rows[i].ConsumptionAmount > rows[j].ConsumptionAmount
	})
	return rows
}
