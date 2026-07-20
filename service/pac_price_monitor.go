package service

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/ratio_setting"

	"gorm.io/gorm"
)

const (
	defaultPACPriceMonitorTargetMargin = 60
	defaultPackyPricingURL             = "https://www.packyapi.com/api/pricing"
	pacMarginDisplayTolerance          = 0.005
)

type PACPriceMonitorParams struct {
	StartTimestamp int64
	EndTimestamp   int64
	ModelName      string
	Channel        int
	TargetMargin   float64
	PreviousRows   []PACPriceMonitorRow
	FetchPricing   func(context.Context) (packyPricingSnapshot, error)
}

type PACPriceMonitorReport struct {
	GeneratedAt    int64                  `json:"generated_at"`
	StartTimestamp int64                  `json:"start_timestamp"`
	EndTimestamp   int64                  `json:"end_timestamp"`
	TargetMargin   float64                `json:"target_margin"`
	Summary        PACPriceMonitorSummary `json:"summary"`
	Rows           []PACPriceMonitorRow   `json:"rows"`
}

type PACPriceMonitorSummary struct {
	CheckedModels         int     `json:"checked_models"`
	HasBaseline           bool    `json:"has_baseline"`
	ChangedPrices         int     `json:"changed_prices"`
	RiskModels            int     `json:"risk_models"`
	UnknownModels         int     `json:"unknown_models"`
	Requests              int64   `json:"requests"`
	Revenue               float64 `json:"revenue"`
	EstimatedUpstreamCost float64 `json:"estimated_upstream_cost"`
	GrossProfit           float64 `json:"gross_profit"`
	GrossMargin           float64 `json:"gross_margin"`
}

type PACPriceMonitorRow struct {
	ChannelID              int     `json:"channel_id"`
	ChannelName            string  `json:"channel_name"`
	ModelName              string  `json:"model_name"`
	LocalGroup             string  `json:"local_group"`
	UpstreamGroup          string  `json:"upstream_group"`
	Status                 string  `json:"status"`
	StatusReason           string  `json:"status_reason"`
	PriceChanged           bool    `json:"price_changed"`
	LocalInputPrice        float64 `json:"local_input_price"`
	LocalOutputPrice       float64 `json:"local_output_price"`
	UpstreamInputPrice     float64 `json:"upstream_input_price"`
	UpstreamOutputPrice    float64 `json:"upstream_output_price"`
	RecommendedInputPrice  float64 `json:"recommended_input_price"`
	RecommendedOutputPrice float64 `json:"recommended_output_price"`
	GrossMargin            float64 `json:"gross_margin"`
	Requests               int64   `json:"requests"`
	PromptTokens           int64   `json:"prompt_tokens"`
	CompletionTokens       int64   `json:"completion_tokens"`
	Revenue                float64 `json:"revenue"`
	EstimatedUpstreamCost  float64 `json:"estimated_upstream_cost"`
	GrossProfit            float64 `json:"gross_profit"`
}

type packyPricingModel struct {
	ModelRatio      float64
	CompletionRatio float64
}

type packyPricingSnapshot struct {
	Models      map[string]packyPricingModel
	GroupRatios map[string]float64
}

type packyPricingResponse struct {
	Success    bool               `json:"success"`
	Data       []packyPricingItem `json:"data"`
	GroupRatio map[string]float64 `json:"group_ratio"`
}

type packyPricingItem struct {
	ModelName       string   `json:"model_name"`
	ModelRatio      float64  `json:"model_ratio"`
	CompletionRatio float64  `json:"completion_ratio"`
	EnableGroups    []string `json:"enable_groups"`
}

type pacUsageAggregate struct {
	ChannelID        int
	ModelName        string
	Requests         int64
	Quota            int64
	PromptTokens     int64
	CompletionTokens int64
}

func BuildPACPriceMonitorReport(ctx context.Context, params PACPriceMonitorParams) (PACPriceMonitorReport, error) {
	if common.QuotaPerUnit <= 0 {
		return PACPriceMonitorReport{}, fmt.Errorf("quota per unit must be positive")
	}
	targetMargin := params.TargetMargin
	if targetMargin <= 0 {
		targetMargin = defaultPACPriceMonitorTargetMargin
	}
	fetchPricing := params.FetchPricing
	if fetchPricing == nil {
		fetchPricing = fetchPackyPricing
	}
	pricing, err := fetchPricing(ctx)
	if err != nil {
		// packyapi 定价获取失败不应阻断其他上游（如 coderelay）；降级为空快照，packyapi 渠道会标为未知
		common.SysError("PAC 巡检 packyapi 定价获取失败，降级仅处理其他上游: " + err.Error())
		pricing = packyPricingSnapshot{}
	}

	channels, err := loadPACPriceMonitorChannels(params)
	if err != nil {
		return PACPriceMonitorReport{}, err
	}
	usage, err := loadPACPriceMonitorUsage(params)
	if err != nil {
		return PACPriceMonitorReport{}, err
	}
	// 非 packyapi 的 new-api 类上游（如 coderelay）按 base_url 实时探测定价
	probePricing := loadProbeUpstreamPricingForPAC(ctx, channels)

	rows := make([]PACPriceMonitorRow, 0)
	for _, channel := range channels {
		if channel == nil {
			continue
		}
		channelPricing := pickPACChannelPricing(channel, pricing, probePricing)
		for _, modelName := range channel.GetModels() {
			modelName = strings.TrimSpace(modelName)
			if modelName == "" {
				continue
			}
			if params.ModelName != "" && modelName != params.ModelName {
				continue
			}
			row := buildPACPriceMonitorRow(channel, modelName, channelPricing, usage[pacUsageKey(channel.Id, modelName)], targetMargin)
			rows = append(rows, row)
		}
	}
	sort.Slice(rows, func(i int, j int) bool {
		if rows[i].ChannelID == rows[j].ChannelID {
			return rows[i].ModelName < rows[j].ModelName
		}
		return rows[i].ChannelID < rows[j].ChannelID
	})
	rows = markPACPriceChanges(rows, params.PreviousRows)

	summary := summarizePACPriceMonitorRows(rows)
	summary.HasBaseline = len(params.PreviousRows) > 0
	return PACPriceMonitorReport{
		GeneratedAt:    time.Now().Unix(),
		StartTimestamp: params.StartTimestamp,
		EndTimestamp:   params.EndTimestamp,
		TargetMargin:   targetMargin,
		Summary:        summary,
		Rows:           rows,
	}, nil
}

func BuildPACPriceMonitorNotification(report PACPriceMonitorReport) (string, string) {
	priceText := "暂无历史价格基准"
	if report.Summary.HasBaseline {
		priceText = "上游价格未变"
	}
	if report.Summary.HasBaseline && report.Summary.ChangedPrices > 0 {
		priceText = fmt.Sprintf("上游价格变更 %d 项", report.Summary.ChangedPrices)
	}
	marginText := "毛利正常"
	if report.Summary.RiskModels > 0 || report.Summary.UnknownModels > 0 {
		marginText = fmt.Sprintf("需关注：低毛利 %d 个，未知 %d 个", report.Summary.RiskModels, report.Summary.UnknownModels)
	}
	content := fmt.Sprintf(
		"%s；%s；检测模型 %d 个；区间收入 $%.4f，估算成本 $%.4f，毛利 $%.4f，毛利率 %.2f%%。",
		priceText,
		marginText,
		report.Summary.CheckedModels,
		report.Summary.Revenue,
		report.Summary.EstimatedUpstreamCost,
		report.Summary.GrossProfit,
		report.Summary.GrossMargin,
	)
	return "PAC 价格巡检通知", content
}

func BuildPACPriceMonitorReportWithLatestSnapshot(ctx context.Context, params PACPriceMonitorParams) (PACPriceMonitorReport, error) {
	previousReport, err := LoadLatestPACPriceMonitorReport()
	if err != nil {
		return PACPriceMonitorReport{}, err
	}
	if previousReport != nil {
		params.PreviousRows = previousReport.Rows
	}
	return BuildPACPriceMonitorReport(ctx, params)
}

func LoadLatestPACPriceMonitorReport() (*PACPriceMonitorReport, error) {
	var task model.SystemTask
	err := model.DB.
		Where("type = ? AND status = ?", model.SystemTaskTypePACPriceMonitor, model.SystemTaskStatusSucceeded).
		Order("id desc").
		First(&task).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	if strings.TrimSpace(task.Result) == "" {
		return nil, nil
	}
	var report PACPriceMonitorReport
	if err := common.UnmarshalJsonStr(task.Result, &report); err != nil {
		return nil, err
	}
	return &report, nil
}

func loadPACPriceMonitorChannels(params PACPriceMonitorParams) ([]*model.Channel, error) {
	query := model.DB.Model(&model.Channel{}).
		Omit("key").
		Where("status = ?", common.ChannelStatusEnabled)
	// packyapi（公开定价）+ 配置了探测凭据的 new-api 类上游（如 coderelay）
	if bases := pacProbeUpstreamBaseURLs(); len(bases) > 0 {
		query = query.Where("(base_url LIKE ? OR name LIKE ? OR base_url IN ?)", "%packyapi.com%", "pac-%", bases)
	} else {
		query = query.Where("(base_url LIKE ? OR name LIKE ?)", "%packyapi.com%", "pac-%")
	}
	if params.Channel > 0 {
		query = query.Where("id = ?", params.Channel)
	}
	var channels []*model.Channel
	err := query.Order("id asc").Find(&channels).Error
	return channels, err
}

func loadPACPriceMonitorUsage(params PACPriceMonitorParams) (map[string]pacUsageAggregate, error) {
	query := model.LOG_DB.Model(&model.Log{}).
		Select("channel_id, model_name, COUNT(*) AS requests, COALESCE(SUM(quota), 0) AS quota, COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, COALESCE(SUM(completion_tokens), 0) AS completion_tokens").
		Where("type = ?", model.LogTypeConsume).
		Where("username <> ?", financeReportExcludedUsername)
	if params.StartTimestamp > 0 {
		query = query.Where("created_at >= ?", params.StartTimestamp)
	}
	if params.EndTimestamp > 0 {
		query = query.Where("created_at < ?", params.EndTimestamp)
	}
	if params.ModelName != "" {
		query = query.Where("model_name = ?", params.ModelName)
	}
	if params.Channel > 0 {
		query = query.Where("channel_id = ?", params.Channel)
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

func buildPACPriceMonitorRow(channel *model.Channel, modelName string, pricing packyPricingSnapshot, usage pacUsageAggregate, targetMargin float64) PACPriceMonitorRow {
	localGroup := channel.Group
	if localGroup == "" {
		localGroup = "default"
	}
	row := PACPriceMonitorRow{
		ChannelID:        channel.Id,
		ChannelName:      channel.Name,
		ModelName:        modelName,
		LocalGroup:       localGroup,
		Requests:         usage.Requests,
		PromptTokens:     usage.PromptTokens,
		CompletionTokens: usage.CompletionTokens,
		Revenue:          float64(usage.Quota) / common.QuotaPerUnit,
	}

	upstreamGroup, ok := resolvePACUpstreamGroup(channel)
	if !ok {
		row.Status = "unknown"
		row.StatusReason = "missing upstream group mapping"
		return row.withProfit()
	}
	row.UpstreamGroup = upstreamGroup

	upstreamGroupRatio, ok := pricing.GroupRatios[upstreamGroup]
	if !ok || upstreamGroupRatio <= 0 {
		row.Status = "unknown"
		row.StatusReason = "missing upstream group ratio"
		return row.withProfit()
	}
	upstreamModel, ok := pricing.Models[modelName]
	if !ok || upstreamModel.ModelRatio <= 0 {
		row.Status = "unknown"
		row.StatusReason = "missing upstream model price"
		return row.withProfit()
	}
	localModelRatio, ok, _ := ratio_setting.GetModelRatio(modelName)
	if !ok || localModelRatio <= 0 {
		row.Status = "unknown"
		row.StatusReason = "missing local model ratio"
		return row.withProfit()
	}

	localGroupRatio := ratio_setting.GetGroupRatio(localGroup)
	localCompletionRatio := ratio_setting.GetCompletionRatio(modelName)
	row.LocalInputPrice = pricePerMillion(localModelRatio, localGroupRatio)
	row.LocalOutputPrice = row.LocalInputPrice * localCompletionRatio
	row.UpstreamInputPrice = pricePerMillion(upstreamModel.ModelRatio, upstreamGroupRatio)
	row.UpstreamOutputPrice = row.UpstreamInputPrice * upstreamModel.CompletionRatio
	row.RecommendedInputPrice = recommendedPrice(row.UpstreamInputPrice, targetMargin)
	row.RecommendedOutputPrice = recommendedPrice(row.UpstreamOutputPrice, targetMargin)
	row.GrossMargin = lowerPACMargin(row)
	row.EstimatedUpstreamCost = tokenCostUSD(
		usage.PromptTokens,
		usage.CompletionTokens,
		upstreamModel.ModelRatio,
		upstreamGroupRatio,
		upstreamModel.CompletionRatio,
	)
	row = row.withProfit()
	if row.GrossMargin+pacMarginDisplayTolerance < targetMargin {
		row.Status = "risk"
		row.StatusReason = "gross margin below target"
		return row
	}
	row.Status = "healthy"
	return row
}

func markPACPriceChanges(rows []PACPriceMonitorRow, previousRows []PACPriceMonitorRow) []PACPriceMonitorRow {
	if len(previousRows) == 0 {
		return rows
	}
	previousByModel := make(map[string]PACPriceMonitorRow, len(previousRows))
	for _, previousRow := range previousRows {
		previousByModel[pacUsageKey(previousRow.ChannelID, previousRow.ModelName)] = previousRow
	}
	for i := range rows {
		previousRow, ok := previousByModel[pacUsageKey(rows[i].ChannelID, rows[i].ModelName)]
		if !ok || !pacUpstreamPriceChanged(rows[i], previousRow) {
			continue
		}
		rows[i].PriceChanged = true
		if rows[i].Status == "healthy" {
			rows[i].Status = "changed"
			rows[i].StatusReason = "upstream price changed"
		} else if rows[i].StatusReason == "" {
			rows[i].StatusReason = "upstream price changed"
		}
	}
	return rows
}

func pacUpstreamPriceChanged(current PACPriceMonitorRow, previous PACPriceMonitorRow) bool {
	if current.UpstreamGroup != "" && previous.UpstreamGroup != "" && current.UpstreamGroup != previous.UpstreamGroup {
		return true
	}
	return priceValueChanged(current.UpstreamInputPrice, previous.UpstreamInputPrice) ||
		priceValueChanged(current.UpstreamOutputPrice, previous.UpstreamOutputPrice)
}

func priceValueChanged(current float64, previous float64) bool {
	return math.Abs(current-previous) > 0.000000001
}

func (row PACPriceMonitorRow) withProfit() PACPriceMonitorRow {
	row.GrossProfit = row.Revenue - row.EstimatedUpstreamCost
	return row
}

func summarizePACPriceMonitorRows(rows []PACPriceMonitorRow) PACPriceMonitorSummary {
	summary := PACPriceMonitorSummary{CheckedModels: len(rows)}
	for _, row := range rows {
		if row.PriceChanged {
			summary.ChangedPrices++
		}
		switch row.Status {
		case "risk":
			summary.RiskModels++
		case "unknown":
			summary.UnknownModels++
		}
		summary.Requests += row.Requests
		summary.Revenue += row.Revenue
		summary.EstimatedUpstreamCost += row.EstimatedUpstreamCost
	}
	summary.GrossProfit = summary.Revenue - summary.EstimatedUpstreamCost
	summary.GrossMargin = financeMargin(summary.Revenue, summary.EstimatedUpstreamCost)
	return summary
}

func fetchPackyPricing(ctx context.Context) (packyPricingSnapshot, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, defaultPackyPricingURL, nil)
	if err != nil {
		return packyPricingSnapshot{}, err
	}
	req.Header.Set("User-Agent", "NewAPI-PAC-Price-Monitor/1.0")
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return packyPricingSnapshot{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return packyPricingSnapshot{}, fmt.Errorf("packy pricing status: %d", resp.StatusCode)
	}
	var payload packyPricingResponse
	if err := common.DecodeJson(resp.Body, &payload); err != nil {
		return packyPricingSnapshot{}, err
	}
	if !payload.Success {
		return packyPricingSnapshot{}, errors.New("packy pricing response is not successful")
	}
	snapshot := packyPricingSnapshot{
		Models:      make(map[string]packyPricingModel, len(payload.Data)),
		GroupRatios: payload.GroupRatio,
	}
	for _, item := range payload.Data {
		modelName := strings.TrimSpace(item.ModelName)
		if modelName == "" {
			continue
		}
		snapshot.Models[modelName] = packyPricingModel{
			ModelRatio:      item.ModelRatio,
			CompletionRatio: item.CompletionRatio,
		}
	}
	return snapshot, nil
}

// pacProbeUpstreamBaseURLs 返回配置了探测凭据的上游 base_url 列表（去尾斜杠），
// 用于把这些 new-api 类上游（如 coderelay）的渠道一并纳入价格巡检。
func pacProbeUpstreamBaseURLs() []string {
	configs, err := LoadUpstreamProbeConfigs()
	if err != nil || len(configs) == 0 {
		return nil
	}
	bases := make([]string, 0, len(configs))
	for _, cfg := range configs {
		if base := normalizeUpstreamBaseURL(cfg.BaseURL); base != "" {
			bases = append(bases, base)
		}
	}
	return bases
}

// loadProbeUpstreamPricingForPAC 对巡检渠道涉及的每个探测上游各拉一次定价，
// 返回 base_url -> 定价快照；单个上游探测失败仅记日志、跳过（该上游渠道会标记为未知）。
func loadProbeUpstreamPricingForPAC(ctx context.Context, channels []*model.Channel) map[string]packyPricingSnapshot {
	configs, err := LoadUpstreamProbeConfigs()
	if err != nil || len(configs) == 0 {
		return nil
	}
	configByBase := make(map[string]UpstreamProbeConfig, len(configs))
	for _, cfg := range configs {
		if base := normalizeUpstreamBaseURL(cfg.BaseURL); base != "" {
			configByBase[base] = cfg
		}
	}
	result := make(map[string]packyPricingSnapshot)
	for _, channel := range channels {
		if channel == nil {
			continue
		}
		base := normalizeUpstreamBaseURL(channel.GetBaseURL())
		if base == "" {
			continue
		}
		if _, done := result[base]; done {
			continue
		}
		cfg, ok := configByBase[base]
		if !ok {
			continue
		}
		snapshot, probeErr := probeUpstreamPricing(ctx, cfg)
		if probeErr != nil {
			common.SysError("PAC 巡检探测上游定价失败 " + base + ": " + probeErr.Error())
			continue
		}
		result[base] = upstreamToPackySnapshot(snapshot)
	}
	return result
}

// upstreamToPackySnapshot 把面板探测的定价快照转成巡检用快照（巡检只用输入/输出倍率）。
func upstreamToPackySnapshot(snapshot upstreamPricingSnapshot) packyPricingSnapshot {
	out := packyPricingSnapshot{
		GroupRatios: snapshot.GroupRatios,
		Models:      make(map[string]packyPricingModel, len(snapshot.Models)),
	}
	for name, m := range snapshot.Models {
		out.Models[name] = packyPricingModel{ModelRatio: m.ModelRatio, CompletionRatio: m.CompletionRatio}
	}
	return out
}

// isPACPackyChannel 判断渠道是否走 packyapi 公开定价（否则走探测上游定价）。
func isPACPackyChannel(channel *model.Channel) bool {
	base := strings.ToLower(channel.GetBaseURL())
	name := strings.ToLower(strings.TrimSpace(channel.Name))
	return strings.Contains(base, "packyapi.com") || strings.HasPrefix(name, "pac-")
}

// pickPACChannelPricing 按渠道选对应上游定价：packyapi 用公开定价，其余用探测定价；无则返回空快照（渠道标未知）。
func pickPACChannelPricing(channel *model.Channel, packy packyPricingSnapshot, probe map[string]packyPricingSnapshot) packyPricingSnapshot {
	if isPACPackyChannel(channel) {
		return packy
	}
	if snapshot, ok := probe[normalizeUpstreamBaseURL(channel.GetBaseURL())]; ok {
		return snapshot
	}
	return packyPricingSnapshot{}
}

func resolvePACUpstreamGroup(channel *model.Channel) (string, bool) {
	settings := channel.GetOtherSettings()
	if settings.PACUpstreamGroup != "" {
		return settings.PACUpstreamGroup, true
	}
	knownGroups := map[string]string{
		"pac-bai":            "bailian",
		"pac-glm":            "glm-sale",
		"pac-gemini":         "gemini-officially",
		"pac-claude-sale-cc": "claude-sale",
		"pac-gpt":            "codex",
		"pac-mimo0.8":        "mimo-officially",
		"pac-hunyuan":        "hunyuan-officially",
		"pac-hunyuan-paid":   "hunyuan-officially",
	}
	group, ok := knownGroups[strings.ToLower(strings.TrimSpace(channel.Name))]
	return group, ok
}

func pacUsageKey(channelID int, modelName string) string {
	return fmt.Sprintf("%d:%s", channelID, modelName)
}

func pricePerMillion(modelRatio float64, groupRatio float64) float64 {
	return modelRatio * groupRatio * 2
}

func recommendedPrice(upstreamPrice float64, targetMargin float64) float64 {
	if upstreamPrice <= 0 {
		return 0
	}
	marginRatio := targetMargin / 100
	if marginRatio <= 0 || marginRatio >= 1 {
		marginRatio = defaultPACPriceMonitorTargetMargin / 100
	}
	return upstreamPrice / (1 - marginRatio)
}

func tokenCostUSD(promptTokens int64, completionTokens int64, modelRatio float64, groupRatio float64, completionRatio float64) float64 {
	billableTokens := float64(promptTokens) + float64(completionTokens)*completionRatio
	return billableTokens * modelRatio * groupRatio / common.QuotaPerUnit
}

func grossMargin(revenue float64, cost float64) float64 {
	if revenue <= 0 {
		return 0
	}
	return (revenue - cost) / revenue * 100
}

func lowerPACMargin(row PACPriceMonitorRow) float64 {
	inputMargin := grossMargin(row.LocalInputPrice, row.UpstreamInputPrice)
	outputMargin := grossMargin(row.LocalOutputPrice, row.UpstreamOutputPrice)
	return math.Min(inputMargin, outputMargin)
}
