package service

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
)

const (
	defaultChannelBusinessReportDays      = 30
	maxChannelBusinessReportDays          = 90
	channelBusinessTopModelsLimit         = 5
	channelBusinessLowBalanceThresholdUSD = 10.0
)

// ChannelBusinessReportParams 经营报表参数；定价/巡检基线均可注入以便测试。
type ChannelBusinessReportParams struct {
	Days int
	// FetchPackyPricing 拉取 packyapi 公开定价；nil 用真实实现
	FetchPackyPricing func(context.Context) (packyPricingSnapshot, error)
	// ProbePricing 按凭据探测 new-api 类上游定价；nil 用真实实现
	ProbePricing func(context.Context, UpstreamProbeConfig) (upstreamPricingSnapshot, error)
	// PreviousRowsLoader 加载最近一次巡检的模型价格基线（用于上游调价标记）；
	// nil 表示从最近成功的巡检任务读取；返回空切片表示无基线
	PreviousRowsLoader func() []PACPriceMonitorRow
}

// ChannelBusinessModelRow 渠道内单个模型的区间经营数据（金额单位 USD）
type ChannelBusinessModelRow struct {
	ModelName             string  `json:"model_name"`
	Requests              int64   `json:"requests"`
	Revenue               float64 `json:"revenue"`                 // 区间收入（用户消费）
	EstimatedUpstreamCost float64 `json:"estimated_upstream_cost"` // 区间估算上游成本（token 级精算）
	GrossProfit           float64 `json:"gross_profit"`
	GrossMargin           float64 `json:"gross_margin"` // 毛利率 %
	LocalInputPrice       float64 `json:"local_input_price"`
	LocalOutputPrice      float64 `json:"local_output_price"`
	LocalPriceKnown       bool    `json:"local_price_known"` // 本站售价是否可算（缺本地倍率时 false）
	UpstreamInputPrice    float64 `json:"upstream_input_price"`
	UpstreamOutputPrice   float64 `json:"upstream_output_price"`
	CostKnown             bool    `json:"cost_known"`
	CostUnknownReason     string  `json:"cost_unknown_reason,omitempty"`
	PriceChanged          bool    `json:"price_changed"` // 上游价相比最近一次巡检是否有变动
}

// ChannelBusinessRow 单个渠道的区间经营数据（金额单位 USD）
type ChannelBusinessRow struct {
	ChannelID             int                       `json:"channel_id"`
	ChannelName           string                    `json:"channel_name"`
	Status                int                       `json:"status"`
	Balance               float64                   `json:"balance"` // 上游余额
	UsedQuotaUSD          float64                   `json:"used_quota_usd"`
	BaseURL               string                    `json:"base_url"`
	LocalGroup            string                    `json:"local_group"`
	UpstreamGroup         string                    `json:"upstream_group"`
	Requests              int64                     `json:"requests"`
	Revenue               float64                   `json:"revenue"`
	EstimatedUpstreamCost float64                   `json:"estimated_upstream_cost"`
	GrossProfit           float64                   `json:"gross_profit"`
	GrossMargin           float64                   `json:"gross_margin"`
	CostKnown             bool                      `json:"cost_known"`   // 该渠道是否掌握上游定价（否则成本整体未知）
	CostPartial           bool                      `json:"cost_partial"` // 部分模型缺上游价，成本/毛利为已知部分口径
	CostUnknownReason     string                    `json:"cost_unknown_reason,omitempty"`
	PriceChanged          bool                      `json:"price_changed"`
	LowBalance            bool                      `json:"low_balance"`
	TopModels             []ChannelBusinessModelRow `json:"top_models"`
}

// ChannelBusinessReport 渠道经营报表
type ChannelBusinessReport struct {
	GeneratedAt         int64                `json:"generated_at"`
	Days                int                  `json:"days"`
	StartTimestamp      int64                `json:"start_timestamp"`
	EndTimestamp        int64                `json:"end_timestamp"`
	LowBalanceThreshold float64              `json:"low_balance_threshold"`
	ProbeErrors         map[string]string    `json:"probe_errors"` // base_url -> 探测错误
	Rows                []ChannelBusinessRow `json:"rows"`
}

// BuildChannelBusinessReport 按渠道聚合区间经营数据：收入（用户消费）、
// 估算上游成本（token 级）、毛利/毛利率、Top 模型、上游调价与低余额标记。
// 没有探测凭据或非 new-api 类上游的渠道也会出现在报告里，成本字段标未知。
func BuildChannelBusinessReport(ctx context.Context, params ChannelBusinessReportParams) (ChannelBusinessReport, error) {
	if common.QuotaPerUnit <= 0 {
		return ChannelBusinessReport{}, fmt.Errorf("quota per unit must be positive")
	}
	days := params.Days
	if days <= 0 {
		days = defaultChannelBusinessReportDays
	}
	if days > maxChannelBusinessReportDays {
		days = maxChannelBusinessReportDays
	}
	end := time.Now().Unix()
	start := end - int64(days)*86400

	fetchPacky := params.FetchPackyPricing
	if fetchPacky == nil {
		fetchPacky = fetchPackyPricing
	}
	probePricing := params.ProbePricing
	if probePricing == nil {
		probePricing = probeUpstreamPricing
	}
	loadPrevious := params.PreviousRowsLoader
	if loadPrevious == nil {
		loadPrevious = loadLatestPACPriceMonitorRows
	}

	// packyapi 公开定价失败降级为空快照（packy 渠道标未知），不阻断其他上游
	packy, err := fetchPacky(ctx)
	if err != nil {
		common.SysError("渠道经营报表 packyapi 定价获取失败，降级为空快照: " + err.Error())
		packy = packyPricingSnapshot{}
	}

	var channels []*model.Channel
	if err := model.DB.Model(&model.Channel{}).Omit("key").Order("id asc").Find(&channels).Error; err != nil {
		return ChannelBusinessReport{}, err
	}

	usage, err := loadChannelBusinessUsage(start, end)
	if err != nil {
		return ChannelBusinessReport{}, err
	}

	snapshots, probeErrors := probeChannelBusinessPricing(ctx, channels, probePricing)
	previousByKey := make(map[string]PACPriceMonitorRow)
	for _, row := range loadPrevious() {
		previousByKey[pacUsageKey(row.ChannelID, row.ModelName)] = row
	}

	rows := make([]ChannelBusinessRow, 0, len(channels))
	for _, channel := range channels {
		if channel == nil {
			continue
		}
		rows = append(rows, buildChannelBusinessRow(channel, packy, snapshots, usage, previousByKey))
	}

	return ChannelBusinessReport{
		GeneratedAt:         time.Now().Unix(),
		Days:                days,
		StartTimestamp:      start,
		EndTimestamp:        end,
		LowBalanceThreshold: channelBusinessLowBalanceThresholdUSD,
		ProbeErrors:         probeErrors,
		Rows:                rows,
	}, nil
}

// loadLatestPACPriceMonitorRows 读取最近一次成功巡检的模型价格基线；失败按无基线降级。
func loadLatestPACPriceMonitorRows() []PACPriceMonitorRow {
	report, err := LoadLatestPACPriceMonitorReport()
	if err != nil {
		common.SysError("渠道经营报表读取巡检基线失败，按无基线降级: " + err.Error())
		return nil
	}
	if report == nil {
		return nil
	}
	return report.Rows
}

// loadChannelBusinessUsage 按 channel_id + model_name 聚合区间消费日志，
// 模式同 loadPACPriceMonitorUsage（排除经营者自用账号，口径与财务报表一致）。
func loadChannelBusinessUsage(startTimestamp int64, endTimestamp int64) (map[string]pacUsageAggregate, error) {
	query := model.LOG_DB.Model(&model.Log{}).
		Select("channel_id, model_name, COUNT(*) AS requests, COALESCE(SUM(quota), 0) AS quota, COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, COALESCE(SUM(completion_tokens), 0) AS completion_tokens").
		Where("type = ?", model.LogTypeConsume).
		Where("username <> ?", financeReportExcludedUsername)
	if startTimestamp > 0 {
		query = query.Where("created_at >= ?", startTimestamp)
	}
	if endTimestamp > 0 {
		query = query.Where("created_at < ?", endTimestamp)
	}
	var aggregates []pacUsageAggregate
	if err := query.Group("channel_id, model_name").Find(&aggregates).Error; err != nil {
		return nil, err
	}
	usage := make(map[string]pacUsageAggregate, len(aggregates))
	for _, aggregate := range aggregates {
		usage[pacUsageKey(aggregate.ChannelID, aggregate.ModelName)] = aggregate
	}
	return usage, nil
}

// probeChannelBusinessPricing 对配置了探测凭据的上游各拉一次定价，
// 返回 base_url -> 快照与 base_url -> 探测错误（单个失败不影响其他上游）。
func probeChannelBusinessPricing(ctx context.Context, channels []*model.Channel, probePricing func(context.Context, UpstreamProbeConfig) (upstreamPricingSnapshot, error)) (map[string]packyPricingSnapshot, map[string]string) {
	snapshots := make(map[string]packyPricingSnapshot)
	probeErrors := make(map[string]string)
	configs, err := LoadUpstreamProbeConfigs()
	if err != nil || len(configs) == 0 {
		return snapshots, probeErrors
	}
	configByBase := make(map[string]UpstreamProbeConfig, len(configs))
	for _, cfg := range configs {
		if base := normalizeUpstreamBaseURL(cfg.BaseURL); base != "" {
			configByBase[base] = cfg
		}
	}
	for _, channel := range channels {
		if channel == nil {
			continue
		}
		base := normalizeUpstreamBaseURL(channel.GetBaseURL())
		if base == "" {
			continue
		}
		cfg, ok := configByBase[base]
		if !ok {
			continue
		}
		if _, done := snapshots[base]; done {
			continue
		}
		if _, failed := probeErrors[base]; failed {
			continue
		}
		snapshot, probeErr := probePricing(ctx, cfg)
		if probeErr != nil {
			probeErrors[base] = probeErr.Error()
			continue
		}
		snapshots[base] = upstreamToPackySnapshot(snapshot)
	}
	return snapshots, probeErrors
}

func buildChannelBusinessRow(channel *model.Channel, packy packyPricingSnapshot, probeSnapshots map[string]packyPricingSnapshot, usage map[string]pacUsageAggregate, previousByKey map[string]PACPriceMonitorRow) ChannelBusinessRow {
	localGroup := channel.Group
	if localGroup == "" {
		localGroup = "default"
	}
	row := ChannelBusinessRow{
		ChannelID:    channel.Id,
		ChannelName:  channel.Name,
		Status:       channel.Status,
		Balance:      channel.Balance,
		UsedQuotaUSD: float64(channel.UsedQuota) / common.QuotaPerUnit,
		BaseURL:      channel.GetBaseURL(),
		LocalGroup:   localGroup,
		LowBalance:   channel.Balance < channelBusinessLowBalanceThresholdUSD,
	}

	pricing := pickPACChannelPricing(channel, packy, probeSnapshots)
	upstreamGroup, groupOK := resolvePACUpstreamGroup(channel)
	if groupOK {
		row.UpstreamGroup = upstreamGroup
	}
	upstreamGroupRatio, ratioOK := pricing.GroupRatios[upstreamGroup]

	// 渠道级成本可知性：需要上游分组 + 该分组的上游倍率
	row.CostKnown, row.CostUnknownReason = channelBusinessCostKnown(channel, groupOK, ratioOK, pricing)

	modelRows := make([]ChannelBusinessModelRow, 0)
	for _, aggregate := range usage {
		if aggregate.ChannelID != channel.Id {
			continue
		}
		modelRow := buildChannelBusinessModelRow(channel, aggregate, pricing, upstreamGroupRatio, row.CostKnown, localGroup)
		// 渠道整体掌握上游定价、但个别模型缺上游价：成本/毛利按已知模型口径，标 partial
		if row.CostKnown && !modelRow.CostKnown && modelRow.Requests > 0 {
			row.CostPartial = true
		}
		row.Requests += modelRow.Requests
		row.Revenue += modelRow.Revenue
		row.EstimatedUpstreamCost += modelRow.EstimatedUpstreamCost
		modelRows = append(modelRows, modelRow)
	}
	sort.SliceStable(modelRows, func(a, b int) bool {
		if modelRows[a].Revenue == modelRows[b].Revenue {
			return modelRows[a].ModelName < modelRows[b].ModelName
		}
		return modelRows[a].Revenue > modelRows[b].Revenue
	})

	// 上游调价标记：任一模型当前上游价与最近巡检基线不一致
	for i := range modelRows {
		previous, ok := previousByKey[pacUsageKey(channel.Id, modelRows[i].ModelName)]
		if !ok {
			continue
		}
		current := PACPriceMonitorRow{
			UpstreamGroup:       row.UpstreamGroup,
			UpstreamInputPrice:  modelRows[i].UpstreamInputPrice,
			UpstreamOutputPrice: modelRows[i].UpstreamOutputPrice,
		}
		if pacUpstreamPriceChanged(current, previous) {
			modelRows[i].PriceChanged = true
			row.PriceChanged = true
		}
	}

	if len(modelRows) > channelBusinessTopModelsLimit {
		row.TopModels = modelRows[:channelBusinessTopModelsLimit]
	} else {
		row.TopModels = modelRows
	}
	row.GrossProfit = row.Revenue - row.EstimatedUpstreamCost
	row.GrossMargin = grossMargin(row.Revenue, row.EstimatedUpstreamCost)
	return row
}

// channelBusinessCostKnown 判断渠道级成本可知性并给出外行能懂的原因。
func channelBusinessCostKnown(channel *model.Channel, groupOK bool, ratioOK bool, pricing packyPricingSnapshot) (bool, string) {
	if !groupOK {
		return false, "未标注上游分组（pac_upstream_group）"
	}
	if len(pricing.GroupRatios) == 0 && len(pricing.Models) == 0 {
		if isPACPackyChannel(channel) {
			return false, "上游公开定价获取失败"
		}
		return false, "未配置探测凭据或上游定价探测失败"
	}
	if !ratioOK {
		return false, "上游未返回该分组倍率"
	}
	return true, ""
}

func buildChannelBusinessModelRow(channel *model.Channel, aggregate pacUsageAggregate, pricing packyPricingSnapshot, upstreamGroupRatio float64, channelCostKnown bool, localGroup string) ChannelBusinessModelRow {
	modelName := strings.TrimSpace(aggregate.ModelName)
	row := ChannelBusinessModelRow{
		ModelName: modelName,
		Requests:  aggregate.Requests,
		Revenue:   float64(aggregate.Quota) / common.QuotaPerUnit,
	}

	if localModelRatio, ok, _ := ratio_setting.GetModelRatio(modelName); ok && localModelRatio > 0 {
		localGroupRatio := ratio_setting.GetGroupRatio(localGroup)
		localCompletionRatio := ratio_setting.GetCompletionRatio(modelName)
		row.LocalInputPrice = pricePerMillion(localModelRatio, localGroupRatio)
		row.LocalOutputPrice = row.LocalInputPrice * localCompletionRatio
		row.LocalPriceKnown = true
	}

	if !channelCostKnown {
		row.CostUnknownReason = "渠道上游定价未知"
		return row
	}
	upstreamModel, ok := pricing.Models[modelName]
	if !ok || upstreamModel.ModelRatio <= 0 {
		row.CostUnknownReason = "上游无该模型价格"
		return row
	}
	row.CostKnown = true
	row.UpstreamInputPrice = pricePerMillion(upstreamModel.ModelRatio, upstreamGroupRatio)
	row.UpstreamOutputPrice = row.UpstreamInputPrice * upstreamModel.CompletionRatio
	row.EstimatedUpstreamCost = tokenCostUSD(
		aggregate.PromptTokens,
		aggregate.CompletionTokens,
		upstreamModel.ModelRatio,
		upstreamGroupRatio,
		upstreamModel.CompletionRatio,
	)
	row.GrossProfit = row.Revenue - row.EstimatedUpstreamCost
	row.GrossMargin = grossMargin(row.Revenue, row.EstimatedUpstreamCost)
	return row
}
