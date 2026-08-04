package service

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	"github.com/QuantumNous/new-api/setting/billing_setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
)

const (
	channelPriceCompareProbeTimeout  = 8 * time.Second
	channelPriceCompareProbeAttempts = 3        // 跨境到部分上游偶发连接卡顿，单次失败后重试
	channelPriceCompareMaxBody       = 10 << 20 // 10MB
	channelPriceComparePairBatchSize = 200
	// UpstreamProbeConfigsOptionKey 系统配置项键名，存各上游站点的探测凭据（JSON 数组）
	UpstreamProbeConfigsOptionKey = "UpstreamProbeConfigs"
)

// UpstreamProbeConfig 一个上游 new-api 站点的探测凭据，按 base_url（上游站点地址）匹配渠道
type UpstreamProbeConfig struct {
	BaseURL     string `json:"base_url"`     // 上游站点地址
	AccessToken string `json:"access_token"` // 上游系统访问令牌（管理令牌，仅用于读 /api/pricing）
	UserID      string `json:"user_id"`      // 上游用户 id（New-Api-User 请求头）
}

// upstreamPricingModel 上游某模型的计费倍率
type upstreamPricingModel struct {
	ModelRatio       float64 // 模型输入倍率
	CompletionRatio  float64 // 输出倍率（相对输入）
	CacheRatio       float64 // 缓存读取倍率
	CreateCacheRatio float64 // 缓存写入倍率
}

type upstreamPricingSnapshot struct {
	GroupRatios  map[string]float64
	Models       map[string]upstreamPricingModel
	QuotaPerUnit float64
}

type upstreamPricingItem struct {
	ModelName        string   `json:"model_name"`
	QuotaType        int      `json:"quota_type"`
	ModelRatio       *float64 `json:"model_ratio"`
	CompletionRatio  *float64 `json:"completion_ratio"`
	CacheRatio       *float64 `json:"cache_ratio"`
	CreateCacheRatio *float64 `json:"create_cache_ratio"`
}

type upstreamPricingResponse struct {
	Success      bool                  `json:"success"`
	Message      string                `json:"message"`
	Data         []upstreamPricingItem `json:"data"`
	GroupRatio   map[string]float64    `json:"group_ratio"`
	QuotaPerUnit float64               `json:"quota_per_unit"`
}

type ChannelBusinessMetrics struct {
	Requests      int64   `json:"requests"`
	Revenue       float64 `json:"revenue"`
	UpstreamCost  float64 `json:"upstream_cost"`
	Profit        float64 `json:"profit"`
	Margin        float64 `json:"margin"`
	CostAvailable bool    `json:"cost_available"`
}

type ChannelQualityMetrics struct {
	Successes      int64   `json:"successes"`
	Errors         int64   `json:"errors"`
	SuccessRate    float64 `json:"success_rate"`
	AverageUseTime float64 `json:"average_use_time"`
	LastErrorAt    int64   `json:"last_error_at"`
	LastErrorCode  string  `json:"last_error_code"`
}

type ChannelPriceCompareSummary struct {
	Today        ChannelBusinessMetrics `json:"today"`
	Total        ChannelBusinessMetrics `json:"total"`
	RiskChannels int                    `json:"risk_channels"`
}

type ChannelPriceCompareChannelSummary struct {
	ChannelID   int                    `json:"channel_id"`
	ChannelName string                 `json:"channel_name"`
	ModelCount  int                    `json:"model_count"`
	RiskCount   int                    `json:"risk_count"`
	Today       ChannelBusinessMetrics `json:"today"`
	Total       ChannelBusinessMetrics `json:"total"`
}

// ChannelPriceCompareChannel 单个渠道在某模型下的上游价、本地价与盈利率（单位美元 / 1M tokens）
type ChannelPriceCompareChannel struct {
	ChannelID          int                    `json:"channel_id"`
	ChannelName        string                 `json:"channel_name"`
	UpstreamGroup      string                 `json:"upstream_group"`
	UpstreamModel      string                 `json:"upstream_model"`
	Priority           int64                  `json:"priority"`
	Weight             uint                   `json:"weight"`
	RoutingRole        string                 `json:"routing_role"`
	Status             string                 `json:"status"`
	StatusReason       string                 `json:"status_reason"`
	PriceSource        string                 `json:"price_source"`
	PriceChanged       bool                   `json:"price_changed"`
	DetectedAvailable  bool                   `json:"detected_available"`
	UsesFixedPrice     bool                   `json:"uses_fixed_price"`
	FixedPrice         float64                `json:"fixed_price"`
	BillingMode        string                 `json:"billing_mode"`
	BillingExpr        string                 `json:"billing_expr,omitempty"`
	LocalInput         float64                `json:"local_input"`
	LocalOutput        float64                `json:"local_output"`
	LocalCacheRead     float64                `json:"local_cache_read"`
	LocalCacheWrite    float64                `json:"local_cache_write"`
	UpstreamInput      float64                `json:"upstream_input"`
	UpstreamOutput     float64                `json:"upstream_output"`
	UpstreamCacheRead  float64                `json:"upstream_cache_read"`
	UpstreamCacheWrite float64                `json:"upstream_cache_write"`
	DetectedInput      float64                `json:"detected_input"`
	DetectedOutput     float64                `json:"detected_output"`
	DetectedCacheRead  float64                `json:"detected_cache_read"`
	DetectedCacheWrite float64                `json:"detected_cache_write"`
	MarginInput        float64                `json:"margin_input"`
	MarginOutput       float64                `json:"margin_output"`
	Today              ChannelBusinessMetrics `json:"today"`
	Total              ChannelBusinessMetrics `json:"total"`
	Quality24h         ChannelQualityMetrics  `json:"quality_24h"`
	Recommendations    []string               `json:"recommendations"`
}

type channelSellingPrices struct {
	Input      float64
	Output     float64
	CacheRead  float64
	CacheWrite float64
}

func tieredSellingPrices(expr string, groupRatio float64) (channelSellingPrices, error) {
	if strings.TrimSpace(expr) == "" || groupRatio <= 0 || common.QuotaPerUnit <= 0 {
		return channelSellingPrices{}, fmt.Errorf("invalid tiered pricing inputs")
	}
	evaluate := func(params billingexpr.TokenParams) (float64, error) {
		quota, _, err := billingexpr.RunExpr(expr, params)
		if err != nil {
			return 0, err
		}
		return quota * groupRatio / float64(common.QuotaPerUnit), nil
	}
	input, err := evaluate(billingexpr.TokenParams{P: 1_000_000, Len: 1})
	if err != nil {
		return channelSellingPrices{}, err
	}
	output, err := evaluate(billingexpr.TokenParams{C: 1_000_000, Len: 1})
	if err != nil {
		return channelSellingPrices{}, err
	}
	cacheRead, err := evaluate(billingexpr.TokenParams{CR: 1_000_000, Len: 1})
	if err != nil {
		return channelSellingPrices{}, err
	}
	cacheWrite, err := evaluate(billingexpr.TokenParams{CC: 1_000_000, Len: 1})
	if err != nil {
		return channelSellingPrices{}, err
	}
	return channelSellingPrices{
		Input: input, Output: output, CacheRead: cacheRead, CacheWrite: cacheWrite,
	}, nil
}

// ChannelPriceCompareModelRow 一个模型及其候选渠道（按优先级降序，与实际选路一致）
type ChannelPriceCompareModelRow struct {
	ModelName string                       `json:"model_name"`
	Channels  []ChannelPriceCompareChannel `json:"channels"`
}

// ChannelPriceCompareReport 面板返回体
type ChannelPriceCompareReport struct {
	GeneratedAt int64                               `json:"generated_at"`
	LocalGroup  string                              `json:"local_group"`
	Summary     ChannelPriceCompareSummary          `json:"summary"`
	Channels    []ChannelPriceCompareChannelSummary `json:"channels"`
	Models      []ChannelPriceCompareModelRow       `json:"models"`
	ProbeErrors map[string]string                   `json:"probe_errors"`
}

// BuildChannelPriceCompareReport 聚合本地启用渠道 + 实时探测各上游定价，
// 按模型分组给出上游价、本地价与盈利率。localGroup 为本地售价使用的分组，默认 default。
func BuildChannelPriceCompareReport(ctx context.Context, localGroup string) (ChannelPriceCompareReport, error) {
	localGroup = strings.TrimSpace(localGroup)
	if localGroup == "" {
		localGroup = "default"
	}

	var abilities []model.Ability
	if err := model.DB.Where(&model.Ability{Group: localGroup, Enabled: true}).Find(&abilities).Error; err != nil {
		return ChannelPriceCompareReport{}, err
	}

	tokenAbilities := make([]model.Ability, 0, len(abilities))
	candidateChannelIDs := make([]int, 0, len(abilities))
	candidateChannelIDSet := make(map[int]struct{}, len(abilities))
	for _, ability := range abilities {
		_, _, exists := ratio_setting.GetModelRatioOrPrice(ability.Model)
		if !exists {
			continue
		}
		tokenAbilities = append(tokenAbilities, ability)
		if _, ok := candidateChannelIDSet[ability.ChannelId]; !ok {
			candidateChannelIDSet[ability.ChannelId] = struct{}{}
			candidateChannelIDs = append(candidateChannelIDs, ability.ChannelId)
		}
	}
	if len(tokenAbilities) == 0 {
		return emptyChannelPriceCompareReport(localGroup), nil
	}

	var channels []*model.Channel
	if err := model.DB.Model(&model.Channel{}).Omit("key").
		Where("id IN ? AND status = ?", candidateChannelIDs, common.ChannelStatusEnabled).
		Find(&channels).Error; err != nil {
		return ChannelPriceCompareReport{}, err
	}
	channelByID := make(map[int]*model.Channel, len(channels))
	for _, channel := range channels {
		channelByID[channel.Id] = channel
	}

	activeAbilities := make([]model.Ability, 0, len(tokenAbilities))
	channelIDs := make([]int, 0, len(channels))
	channelIDSet := make(map[int]struct{}, len(channels))
	for _, ability := range tokenAbilities {
		if channelByID[ability.ChannelId] == nil {
			continue
		}
		activeAbilities = append(activeAbilities, ability)
		if _, ok := channelIDSet[ability.ChannelId]; !ok {
			channelIDSet[ability.ChannelId] = struct{}{}
			channelIDs = append(channelIDs, ability.ChannelId)
		}
	}
	if len(activeAbilities) == 0 {
		return emptyChannelPriceCompareReport(localGroup), nil
	}
	activePairs := make([]channelModelPair, 0, len(activeAbilities))
	for _, ability := range activeAbilities {
		activePairs = append(activePairs, channelModelPair{
			ChannelID: ability.ChannelId,
			ModelName: ability.Model,
		})
	}

	now := time.Now()
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return ChannelPriceCompareReport{}, err
	}
	localNow := now.In(shanghai)
	todayStart := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, shanghai).Unix()
	totalUsage, err := loadChannelUsage(activePairs, 0)
	if err != nil {
		return ChannelPriceCompareReport{}, err
	}
	todayUsage, err := loadChannelUsage(activePairs, todayStart)
	if err != nil {
		return ChannelPriceCompareReport{}, err
	}
	quality, err := loadChannelQuality(activePairs, now.Add(-24*time.Hour).Unix())
	if err != nil {
		return ChannelPriceCompareReport{}, err
	}

	configs, err := LoadUpstreamProbeConfigs()
	if err != nil {
		return ChannelPriceCompareReport{}, err
	}
	configByBase := make(map[string]UpstreamProbeConfig, len(configs))
	for _, cfg := range configs {
		if base := normalizeUpstreamBaseURL(cfg.BaseURL); base != "" {
			configByBase[base] = cfg
		}
	}
	snapshots, probeErrors := probeChannelUpstreams(ctx, channels, configByBase)
	modelIndex := make(map[string]int)
	rows := make([]ChannelPriceCompareModelRow, 0)
	localGroupRatio := ratio_setting.GetGroupRatio(localGroup)

	for _, ability := range activeAbilities {
		channel := channelByID[ability.ChannelId]
		base := normalizeUpstreamBaseURL(channel.GetBaseURL())
		settings := channel.GetOtherSettings()
		row := buildChannelPriceCompareRow(
			channel,
			strings.TrimSpace(settings.PACUpstreamGroup),
			ability.Model,
			snapshots[base],
			localGroupRatio,
		)
		row.Priority = 0
		if ability.Priority != nil {
			row.Priority = *ability.Priority
		}
		row.Weight = ability.Weight
		key := channelPriceCompareUsageKey(channel.Id, ability.Model)
		row.Today = buildChannelBusinessMetrics(todayUsage[key], row)
		row.Total = buildChannelBusinessMetrics(totalUsage[key], row)
		row.Quality24h = quality[key]
		row.Recommendations = channelRecommendations(row)

		idx, exists := modelIndex[ability.Model]
		if !exists {
			idx = len(rows)
			modelIndex[ability.Model] = idx
			rows = append(rows, ChannelPriceCompareModelRow{ModelName: ability.Model})
		}
		rows[idx].Channels = append(rows[idx].Channels, row)
	}

	for i := range rows {
		maxPriority := rows[i].Channels[0].Priority
		topPriorityCount := 0
		for _, channel := range rows[i].Channels {
			if channel.Priority > maxPriority {
				maxPriority = channel.Priority
				topPriorityCount = 1
			} else if channel.Priority == maxPriority {
				topPriorityCount++
			}
		}
		for channelIndex := range rows[i].Channels {
			channel := &rows[i].Channels[channelIndex]
			if channel.Priority != maxPriority {
				channel.RoutingRole = "backup"
			} else if topPriorityCount > 1 {
				channel.RoutingRole = "primary_pool"
			} else {
				channel.RoutingRole = "primary"
			}
		}
		sort.SliceStable(rows[i].Channels, func(a, b int) bool {
			if rows[i].Channels[a].Priority != rows[i].Channels[b].Priority {
				return rows[i].Channels[a].Priority > rows[i].Channels[b].Priority
			}
			return rows[i].Channels[a].ChannelName < rows[i].Channels[b].ChannelName
		})
	}
	sort.SliceStable(rows, func(a, b int) bool {
		return rows[a].ModelName < rows[b].ModelName
	})

	summary, channelSummaries := summarizeChannelPriceCompare(rows)
	return ChannelPriceCompareReport{
		GeneratedAt: time.Now().Unix(),
		LocalGroup:  localGroup,
		Summary:     summary,
		Channels:    channelSummaries,
		Models:      rows,
		ProbeErrors: probeErrors,
	}, nil
}

func emptyChannelPriceCompareReport(localGroup string) ChannelPriceCompareReport {
	return ChannelPriceCompareReport{
		GeneratedAt: time.Now().Unix(),
		LocalGroup:  localGroup,
		Summary: ChannelPriceCompareSummary{
			Today: ChannelBusinessMetrics{CostAvailable: true},
			Total: ChannelBusinessMetrics{CostAvailable: true},
		},
		ProbeErrors: map[string]string{},
	}
}

type channelUpstreamProbeJob struct {
	base          string
	config        UpstreamProbeConfig
	channelLabels []string
}

type channelUpstreamProbeResult struct {
	base          string
	channelLabels []string
	snapshot      upstreamPricingSnapshot
	err           error
}

func probeChannelUpstreams(
	ctx context.Context,
	channels []*model.Channel,
	configByBase map[string]UpstreamProbeConfig,
) (map[string]upstreamPricingSnapshot, map[string]string) {
	const (
		maxWorkers    = 4
		reportTimeout = 12 * time.Second
	)

	jobByBase := make(map[string]channelUpstreamProbeJob)
	for _, channel := range channels {
		base := normalizeUpstreamBaseURL(channel.GetBaseURL())
		cfg, ok := configByBase[base]
		if !ok {
			continue
		}
		job := jobByBase[base]
		job.base = base
		job.config = cfg
		job.channelLabels = append(job.channelLabels, fmt.Sprintf("%s (#%d)", channel.Name, channel.Id))
		jobByBase[base] = job
	}
	snapshots := make(map[string]upstreamPricingSnapshot, len(jobByBase))
	probeErrors := make(map[string]string)
	if len(jobByBase) == 0 {
		return snapshots, probeErrors
	}

	probeCtx, cancel := context.WithTimeout(ctx, reportTimeout)
	defer cancel()
	jobs := make(chan channelUpstreamProbeJob, len(jobByBase))
	results := make(chan channelUpstreamProbeResult, len(jobByBase))
	for _, job := range jobByBase {
		jobs <- job
	}
	close(jobs)

	workerCount := min(maxWorkers, len(jobByBase))
	var workers sync.WaitGroup
	workers.Add(workerCount)
	for range workerCount {
		go func() {
			defer workers.Done()
			for job := range jobs {
				snapshot, err := probeUpstreamPricing(probeCtx, job.config)
				results <- channelUpstreamProbeResult{
					base:          job.base,
					channelLabels: job.channelLabels,
					snapshot:      snapshot,
					err:           err,
				}
			}
		}()
	}
	go func() {
		workers.Wait()
		close(results)
	}()

	for result := range results {
		snapshots[result.base] = result.snapshot
		if result.err != nil {
			for _, label := range result.channelLabels {
				probeErrors[label] = channelProbeErrorCode(result.err)
			}
		}
	}
	return snapshots, probeErrors
}

func channelProbeErrorCode(err error) string {
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "deadline"),
		strings.Contains(message, "timeout"),
		strings.Contains(message, "canceled"):
		return "Upstream probe timed out"
	case strings.Contains(message, "429"),
		strings.Contains(message, "rate limit"):
		return "Upstream probe rate limited"
	case strings.Contains(message, "401"),
		strings.Contains(message, "403"),
		strings.Contains(message, "unauthorized"):
		return "Upstream probe authentication failed"
	case strings.Contains(message, "404"),
		strings.Contains(message, "not found"):
		return "Upstream pricing endpoint not found"
	default:
		return "Upstream pricing probe failed"
	}
}

func buildChannelPriceCompareRow(channel *model.Channel, upstreamGroup string, modelName string, snapshot upstreamPricingSnapshot, localGroupRatio float64) ChannelPriceCompareChannel {
	upstreamModelName := modelName
	if rawMapping := strings.TrimSpace(channel.GetModelMapping()); rawMapping != "" {
		var mapping map[string]string
		if common.UnmarshalJsonStr(rawMapping, &mapping) == nil {
			if mapped := strings.TrimSpace(mapping[modelName]); mapped != "" {
				upstreamModelName = mapped
			}
		}
	}
	row := ChannelPriceCompareChannel{
		ChannelID:       channel.Id,
		ChannelName:     channel.Name,
		UpstreamGroup:   upstreamGroup,
		UpstreamModel:   upstreamModelName,
		Priority:        channelPriorityValue(channel),
		Weight:          uint(channel.GetWeight()),
		PriceSource:     "missing",
		Recommendations: []string{},
	}

	row.BillingMode = billing_setting.GetBillingMode(modelName)

	pricing := ratio_setting.GetModelPricingSnapshot(modelName)
	if row.BillingMode == billing_setting.BillingModeTieredExpr {
		if expr, ok := billing_setting.GetBillingExpr(modelName); ok {
			row.BillingExpr = expr
			if prices, err := tieredSellingPrices(expr, localGroupRatio); err == nil {
				row.LocalInput = prices.Input
				row.LocalOutput = prices.Output
				row.LocalCacheRead = prices.CacheRead
				row.LocalCacheWrite = prices.CacheWrite
			}
		}
	} else if pricing.UsesFixedPrice {
		row.UsesFixedPrice = true
		row.FixedPrice = pricing.ModelPrice * localGroupRatio
	} else if pricing.ModelRatioFound && pricing.ModelRatio > 0 {
		row.LocalInput = localPricePerMillion(pricing.ModelRatio, localGroupRatio)
		row.LocalOutput = localPricePerMillion(pricing.ModelRatio*pricing.CompletionRatio, localGroupRatio)
		row.LocalCacheRead = localPricePerMillion(pricing.ModelRatio*pricing.CacheRatio, localGroupRatio)
		row.LocalCacheWrite = localPricePerMillion(pricing.ModelRatio*pricing.CreateCacheRatio, localGroupRatio)
	}

	groupRatio, groupRatioFound := snapshot.GroupRatios[upstreamGroup]
	detected := false
	if upstreamGroup != "" &&
		groupRatioFound &&
		validUpstreamRatioValue(groupRatio) {
		if upstreamModel, ok := snapshot.Models[upstreamModelName]; ok {
			upstreamQuotaPerUnit := normalizeUpstreamQuotaPerUnit(snapshot.QuotaPerUnit)
			row.DetectedInput = pricePerMillionForQuota(upstreamModel.ModelRatio, groupRatio, upstreamQuotaPerUnit)
			row.DetectedOutput = pricePerMillionForQuota(upstreamModel.ModelRatio*upstreamModel.CompletionRatio, groupRatio, upstreamQuotaPerUnit)
			row.DetectedCacheRead = pricePerMillionForQuota(upstreamModel.ModelRatio*upstreamModel.CacheRatio, groupRatio, upstreamQuotaPerUnit)
			row.DetectedCacheWrite = pricePerMillionForQuota(upstreamModel.ModelRatio*upstreamModel.CreateCacheRatio, groupRatio, upstreamQuotaPerUnit)
			detected = true
			row.DetectedAvailable = true
		}
	}

	settings := channel.GetOtherSettings()
	manualPrice, hasManualPrice := settings.ModelPrices[modelName]
	manualPriceComplete := hasManualPrice &&
		manualPrice.Input != nil &&
		manualPrice.Output != nil &&
		manualPrice.CacheRead != nil &&
		manualPrice.CacheWrite != nil
	if manualPriceComplete {
		row.UpstreamInput = *manualPrice.Input
		row.UpstreamOutput = *manualPrice.Output
		row.UpstreamCacheRead = *manualPrice.CacheRead
		row.UpstreamCacheWrite = *manualPrice.CacheWrite
		row.PriceSource = "manual"
		row.Status = "ok"
		if detected {
			row.PriceChanged = channelPriceValuesDiffer(row)
		}
	} else if detected {
		row.UpstreamInput = row.DetectedInput
		row.UpstreamOutput = row.DetectedOutput
		row.UpstreamCacheRead = row.DetectedCacheRead
		row.UpstreamCacheWrite = row.DetectedCacheWrite
		row.PriceSource = "detected"
		row.Status = "ok"
	} else {
		row.Status = "unknown"
		switch {
		case upstreamGroup == "":
			row.StatusReason = "No upstream group or purchase price"
		case len(snapshot.GroupRatios) == 0:
			row.StatusReason = "No purchase price and upstream pricing unavailable"
		case !groupRatioFound || !validUpstreamRatioValue(groupRatio):
			row.StatusReason = "Upstream pricing group not found"
		default:
			row.StatusReason = "Upstream model price not found"
		}
		return row
	}

	if !row.UsesFixedPrice {
		row.MarginInput = grossMargin(row.LocalInput, row.UpstreamInput)
		row.MarginOutput = grossMargin(row.LocalOutput, row.UpstreamOutput)
	}
	return row
}

type channelModelPair struct {
	ChannelID int
	ModelName string
}

func channelModelPairFilter(pairs []channelModelPair) (string, []any) {
	if len(pairs) == 0 {
		return "1 = 0", nil
	}
	clauses := make([]string, 0, len(pairs))
	args := make([]any, 0, len(pairs)*2)
	for _, pair := range pairs {
		clauses = append(clauses, "(channel_id = ? AND model_name = ?)")
		args = append(args, pair.ChannelID, pair.ModelName)
	}
	return "(" + strings.Join(clauses, " OR ") + ")", args
}

func channelModelPairBatches(pairs []channelModelPair) [][]channelModelPair {
	uniquePairs := make([]channelModelPair, 0, len(pairs))
	seen := make(map[string]struct{}, len(pairs))
	for _, pair := range pairs {
		key := channelPriceCompareUsageKey(pair.ChannelID, pair.ModelName)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		uniquePairs = append(uniquePairs, pair)
	}

	batches := make([][]channelModelPair, 0, (len(uniquePairs)+channelPriceComparePairBatchSize-1)/channelPriceComparePairBatchSize)
	for start := 0; start < len(uniquePairs); start += channelPriceComparePairBatchSize {
		end := min(start+channelPriceComparePairBatchSize, len(uniquePairs))
		batches = append(batches, uniquePairs[start:end])
	}
	return batches
}

type channelUsageAggregate struct {
	ChannelID        int
	ModelName        string
	Requests         int64
	Quota            int64
	InputTokens      int64
	CompletionTokens int64
	CacheReadTokens  int64
	CacheWriteTokens int64
}

type channelQualityAggregate struct {
	ChannelID int
	ModelName string
	Type      int
	Requests  int64
	UseTime   int64
}

func channelPriceCompareUsageKey(channelID int, modelName string) string {
	return fmt.Sprintf("%d\x00%s", channelID, modelName)
}

func loadChannelUsage(pairs []channelModelPair, startTimestamp int64) (map[string]channelUsageAggregate, error) {
	inputTokens, cacheReadTokens, cacheWriteTokens := channelUsageTokenExpressions()
	selectClause := fmt.Sprintf(
		"channel_id, model_name, COUNT(*) AS requests, COALESCE(SUM(quota), 0) AS quota, COALESCE(SUM(%s), 0) AS input_tokens, COALESCE(SUM(completion_tokens), 0) AS completion_tokens, COALESCE(SUM(%s), 0) AS cache_read_tokens, COALESCE(SUM(%s), 0) AS cache_write_tokens",
		inputTokens, cacheReadTokens, cacheWriteTokens,
	)
	result := make(map[string]channelUsageAggregate)
	for _, batch := range channelModelPairBatches(pairs) {
		pairFilter, pairArgs := channelModelPairFilter(batch)
		query := model.LOG_DB.Model(&model.Log{}).
			Select(selectClause).
			Where("type = ?", model.LogTypeConsume).
			Where(pairFilter, pairArgs...)
		if startTimestamp > 0 {
			query = query.Where("created_at >= ?", startTimestamp)
		}
		var aggregates []channelUsageAggregate
		if err := query.Group("channel_id, model_name").Find(&aggregates).Error; err != nil {
			return nil, err
		}
		for _, aggregate := range aggregates {
			result[channelPriceCompareUsageKey(aggregate.ChannelID, aggregate.ModelName)] = aggregate
		}
	}
	return result, nil
}

func channelUsageTokenExpressions() (inputTokens string, cacheReadTokens string, cacheWriteTokens string) {
	jsonNumber := func(key string) string {
		return fmt.Sprintf(
			"CAST(COALESCE(json_extract(CASE WHEN json_valid(other) THEN other ELSE '{}' END, '$.%s'), 0) AS INTEGER)",
			key,
		)
	}
	jsonBoolean := func(key string) string {
		return fmt.Sprintf(
			"COALESCE(json_extract(CASE WHEN json_valid(other) THEN other ELSE '{}' END, '$.%s'), 0) = 1",
			key,
		)
	}
	greatest := "MAX"

	switch {
	case common.UsingLogDatabase(common.DatabaseTypeMySQL):
		jsonNumber = func(key string) string {
			return fmt.Sprintf(
				"CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(other), other, '{}'), '$.%s')), '0') AS SIGNED)",
				key,
			)
		}
		jsonBoolean = func(key string) string {
			return fmt.Sprintf(
				"JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(other), other, '{}'), '$.%s')) = 'true'",
				key,
			)
		}
		greatest = "GREATEST"
	case common.UsingLogDatabase(common.DatabaseTypePostgreSQL):
		jsonNumber = func(key string) string {
			return fmt.Sprintf(
				"CAST(COALESCE(substring(other from '\"%s\"[[:space:]]*:[[:space:]]*(-?[0-9]+)'), '0') AS BIGINT)",
				key,
			)
		}
		jsonBoolean = func(key string) string {
			return fmt.Sprintf(
				"other ~ '\"%s\"[[:space:]]*:[[:space:]]*true'",
				key,
			)
		}
		greatest = "GREATEST"
	case common.UsingLogDatabase(common.DatabaseTypeClickHouse):
		jsonNumber = func(key string) string {
			return fmt.Sprintf("toInt64OrZero(JSONExtractRaw(other, '%s'))", key)
		}
		jsonBoolean = func(key string) string {
			return fmt.Sprintf("JSONExtractBool(other, '%s') = 1", key)
		}
		greatest = "greatest"
	}

	cacheReadTokens = jsonNumber("cache_tokens")
	cacheWriteTokens = fmt.Sprintf(
		"%s(%s, %s)",
		greatest,
		jsonNumber("cache_write_tokens"),
		jsonNumber("cache_creation_tokens"),
	)
	uncachedInputTokens := fmt.Sprintf(
		"%s(prompt_tokens - (%s) - (%s), 0)",
		greatest,
		cacheReadTokens,
		cacheWriteTokens,
	)
	inputTokens = fmt.Sprintf(
		"CASE WHEN %s THEN prompt_tokens ELSE %s END",
		jsonBoolean("claude"),
		uncachedInputTokens,
	)
	return inputTokens, cacheReadTokens, cacheWriteTokens
}

func loadChannelQuality(pairs []channelModelPair, startTimestamp int64) (map[string]ChannelQualityMetrics, error) {
	result := make(map[string]ChannelQualityMetrics)
	for _, batch := range channelModelPairBatches(pairs) {
		pairFilter, pairArgs := channelModelPairFilter(batch)
		var aggregates []channelQualityAggregate
		if err := model.LOG_DB.Model(&model.Log{}).
			Select("channel_id, model_name, type, COUNT(*) AS requests, COALESCE(SUM(use_time), 0) AS use_time").
			Where(pairFilter, pairArgs...).
			Where("type IN ? AND created_at >= ?", []int{model.LogTypeConsume, model.LogTypeError}, startTimestamp).
			Group("channel_id, model_name, type").
			Find(&aggregates).Error; err != nil {
			return nil, err
		}
		for _, aggregate := range aggregates {
			key := channelPriceCompareUsageKey(aggregate.ChannelID, aggregate.ModelName)
			metrics := result[key]
			if aggregate.Type == model.LogTypeConsume {
				metrics.Successes = aggregate.Requests
				if aggregate.Requests > 0 {
					metrics.AverageUseTime = float64(aggregate.UseTime) / float64(aggregate.Requests)
				}
			} else {
				metrics.Errors = aggregate.Requests
			}
			result[key] = metrics
		}

		latestErrorTimes := model.LOG_DB.Model(&model.Log{}).
			Select("channel_id, model_name, MAX(created_at) AS created_at").
			Where(pairFilter, pairArgs...).
			Where("type = ? AND created_at >= ?", model.LogTypeError, startTimestamp).
			Group("channel_id, model_name")
		var latestErrorIDs []struct {
			ID int64
		}
		if err := model.LOG_DB.Table("logs AS error_logs").
			Select("MAX(error_logs.id) AS id").
			Joins("INNER JOIN (?) AS latest_errors ON latest_errors.channel_id = error_logs.channel_id AND latest_errors.model_name = error_logs.model_name AND latest_errors.created_at = error_logs.created_at", latestErrorTimes).
			Where("error_logs.type = ?", model.LogTypeError).
			Group("error_logs.channel_id, error_logs.model_name").
			Find(&latestErrorIDs).Error; err != nil {
			return nil, err
		}
		if len(latestErrorIDs) > 0 {
			ids := make([]int64, 0, len(latestErrorIDs))
			for _, latestError := range latestErrorIDs {
				ids = append(ids, latestError.ID)
			}
			var latestErrors []model.Log
			if err := model.LOG_DB.Model(&model.Log{}).
				Select("channel_id, model_name, created_at, content").
				Where("id IN ?", ids).
				Find(&latestErrors).Error; err != nil {
				return nil, err
			}
			for _, errorLog := range latestErrors {
				key := channelPriceCompareUsageKey(errorLog.ChannelId, errorLog.ModelName)
				metrics := result[key]
				metrics.LastErrorAt = errorLog.CreatedAt
				metrics.LastErrorCode = channelErrorCode(errorLog.Content)
				result[key] = metrics
			}
		}
	}
	for key, metrics := range result {
		attempts := metrics.Successes + metrics.Errors
		if attempts > 0 {
			metrics.SuccessRate = float64(metrics.Successes) / float64(attempts) * 100
		}
		result[key] = metrics
	}
	return result, nil
}

func channelErrorCode(content string) string {
	message := strings.ToLower(content)
	switch {
	case strings.Contains(message, "deadline"),
		strings.Contains(message, "timeout"),
		strings.Contains(message, "timed out"):
		return "Upstream request timed out"
	case strings.Contains(message, "429"),
		strings.Contains(message, "rate limit"),
		strings.Contains(message, "too many requests"):
		return "Upstream request rate limited"
	case strings.Contains(message, "401"),
		strings.Contains(message, "403"),
		strings.Contains(message, "unauthorized"),
		strings.Contains(message, "api key"),
		strings.Contains(message, "authentication"):
		return "Upstream authentication failed"
	case strings.Contains(message, "model not found"),
		strings.Contains(message, "model_not_found"),
		strings.Contains(message, "does not exist"):
		return "Upstream model unavailable"
	case strings.Contains(message, "connection"),
		strings.Contains(message, "dial tcp"),
		strings.Contains(message, "no such host"),
		strings.Contains(message, "tls"):
		return "Upstream connection failed"
	default:
		return "Upstream request failed"
	}
}

func buildChannelBusinessMetrics(usage channelUsageAggregate, row ChannelPriceCompareChannel) ChannelBusinessMetrics {
	revenue := 0.0
	if common.QuotaPerUnit > 0 {
		revenue = float64(usage.Quota) / common.QuotaPerUnit
	}
	metrics := ChannelBusinessMetrics{
		Requests:      usage.Requests,
		Revenue:       revenue,
		CostAvailable: usage.Requests == 0 || row.PriceSource != "missing",
	}
	if !metrics.CostAvailable {
		return metrics
	}
	inputTokens := math.Max(float64(usage.InputTokens), 0)
	completionTokens := math.Max(float64(usage.CompletionTokens), 0)
	cacheReadTokens := math.Max(float64(usage.CacheReadTokens), 0)
	cacheWriteTokens := math.Max(float64(usage.CacheWriteTokens), 0)
	metrics.UpstreamCost = inputTokens/1_000_000*row.UpstreamInput +
		completionTokens/1_000_000*row.UpstreamOutput +
		cacheReadTokens/1_000_000*row.UpstreamCacheRead +
		cacheWriteTokens/1_000_000*row.UpstreamCacheWrite
	metrics.Profit = revenue - metrics.UpstreamCost
	if revenue > 0 {
		metrics.Margin = metrics.Profit / revenue * 100
	}
	return metrics
}

func channelPriceValuesDiffer(row ChannelPriceCompareChannel) bool {
	return math.Abs(row.UpstreamInput-row.DetectedInput) > 0.000001 ||
		math.Abs(row.UpstreamOutput-row.DetectedOutput) > 0.000001 ||
		math.Abs(row.UpstreamCacheRead-row.DetectedCacheRead) > 0.000001 ||
		math.Abs(row.UpstreamCacheWrite-row.DetectedCacheWrite) > 0.000001
}

func channelRecommendations(row ChannelPriceCompareChannel) []string {
	recommendations := make([]string, 0, 3)
	if row.PriceSource == "missing" {
		recommendations = append(recommendations, "missing_price")
	}
	if row.PriceChanged {
		recommendations = append(recommendations, "price_changed")
	}
	lowerMargin := math.Inf(1)
	hasComparableMargin := false
	negativeUnitEconomics := false
	if !row.UsesFixedPrice {
		for _, prices := range [][2]float64{
			{row.LocalInput, row.UpstreamInput},
			{row.LocalOutput, row.UpstreamOutput},
			{row.LocalCacheRead, row.UpstreamCacheRead},
			{row.LocalCacheWrite, row.UpstreamCacheWrite},
		} {
			if prices[0] > 0 {
				hasComparableMargin = true
				lowerMargin = math.Min(lowerMargin, grossMargin(prices[0], prices[1]))
			} else if prices[1] > 0 {
				negativeUnitEconomics = true
			}
		}
	}
	actualLoss := (row.Today.CostAvailable && row.Today.Requests > 0 && row.Today.Profit < 0) ||
		(row.Total.CostAvailable && row.Total.Requests > 0 && row.Total.Profit < 0)
	actualLowMargin := false
	if row.UsesFixedPrice {
		for _, metrics := range []ChannelBusinessMetrics{row.Today, row.Total} {
			if metrics.CostAvailable && metrics.Requests > 0 && metrics.Revenue > 0 &&
				metrics.Margin < defaultPACPriceMonitorTargetMargin {
				actualLowMargin = true
				break
			}
		}
	}
	if row.PriceSource != "missing" && (actualLoss || negativeUnitEconomics || lowerMargin < 0) {
		recommendations = append(recommendations, "negative_margin")
	} else if row.PriceSource != "missing" &&
		(actualLowMargin || hasComparableMargin && lowerMargin < defaultPACPriceMonitorTargetMargin) {
		recommendations = append(recommendations, "low_margin")
	}
	attempts := row.Quality24h.Successes + row.Quality24h.Errors
	if attempts >= 20 && row.Quality24h.SuccessRate < 95 {
		recommendations = append(recommendations, "low_success_rate")
	}
	return recommendations
}

func addChannelBusinessMetrics(total *ChannelBusinessMetrics, value ChannelBusinessMetrics) {
	total.Requests += value.Requests
	total.Revenue += value.Revenue
	if !total.CostAvailable || !value.CostAvailable {
		total.CostAvailable = false
		total.UpstreamCost = 0
		total.Profit = 0
		total.Margin = 0
		return
	}
	total.UpstreamCost += value.UpstreamCost
	total.Profit = total.Revenue - total.UpstreamCost
	if total.Revenue > 0 {
		total.Margin = total.Profit / total.Revenue * 100
	}
}

func summarizeChannelPriceCompare(rows []ChannelPriceCompareModelRow) (ChannelPriceCompareSummary, []ChannelPriceCompareChannelSummary) {
	summary := ChannelPriceCompareSummary{
		Today: ChannelBusinessMetrics{CostAvailable: true},
		Total: ChannelBusinessMetrics{CostAvailable: true},
	}
	channelIndex := make(map[int]int)
	riskChannels := make(map[int]struct{})
	channels := make([]ChannelPriceCompareChannelSummary, 0)
	for _, modelRow := range rows {
		for _, row := range modelRow.Channels {
			addChannelBusinessMetrics(&summary.Today, row.Today)
			addChannelBusinessMetrics(&summary.Total, row.Total)
			idx, exists := channelIndex[row.ChannelID]
			if !exists {
				idx = len(channels)
				channelIndex[row.ChannelID] = idx
				channels = append(channels, ChannelPriceCompareChannelSummary{
					ChannelID:   row.ChannelID,
					ChannelName: row.ChannelName,
					Today:       ChannelBusinessMetrics{CostAvailable: true},
					Total:       ChannelBusinessMetrics{CostAvailable: true},
				})
			}
			channels[idx].ModelCount++
			addChannelBusinessMetrics(&channels[idx].Today, row.Today)
			addChannelBusinessMetrics(&channels[idx].Total, row.Total)
			if len(row.Recommendations) > 0 {
				channels[idx].RiskCount++
				riskChannels[row.ChannelID] = struct{}{}
			}
		}
	}
	summary.RiskChannels = len(riskChannels)
	sort.SliceStable(channels, func(i, j int) bool {
		if channels[i].RiskCount != channels[j].RiskCount {
			return channels[i].RiskCount > channels[j].RiskCount
		}
		if channels[i].Today.UpstreamCost != channels[j].Today.UpstreamCost {
			return channels[i].Today.UpstreamCost > channels[j].Today.UpstreamCost
		}
		return channels[i].ChannelName < channels[j].ChannelName
	})
	return summary, channels
}

func channelPriorityValue(channel *model.Channel) int64 {
	if channel.Priority == nil {
		return 0
	}
	return *channel.Priority
}

func normalizeUpstreamBaseURL(raw string) string {
	return strings.TrimRight(strings.TrimSpace(raw), "/")
}

// LoadUpstreamProbeConfigs 从系统配置项读取上游探测凭据列表
func LoadUpstreamProbeConfigs() ([]UpstreamProbeConfig, error) {
	common.OptionMapRWMutex.RLock()
	raw := common.OptionMap[UpstreamProbeConfigsOptionKey]
	common.OptionMapRWMutex.RUnlock()
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "[]" {
		return nil, nil
	}
	var configs []UpstreamProbeConfig
	if err := common.UnmarshalJsonStr(raw, &configs); err != nil {
		return nil, fmt.Errorf("上游探测配置解析失败: %w", err)
	}
	return configs, nil
}

// probeUpstreamPricing 探测上游定价；跨境到部分上游偶发连接卡顿（TCP 握手可卡满单次超时），
// 失败按 channelPriceCompareProbeAttempts 次重试，重试通常立即恢复。
func probeUpstreamPricing(ctx context.Context, cfg UpstreamProbeConfig) (upstreamPricingSnapshot, error) {
	var lastErr error
	for attempt := 0; attempt < channelPriceCompareProbeAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return upstreamPricingSnapshot{}, err
		}
		snapshot, err := probeUpstreamPricingOnce(ctx, cfg)
		if err == nil {
			return snapshot, nil
		}
		lastErr = err
	}
	return upstreamPricingSnapshot{}, lastErr
}

func probeUpstreamPricingOnce(ctx context.Context, cfg UpstreamProbeConfig) (upstreamPricingSnapshot, error) {
	base := normalizeUpstreamBaseURL(cfg.BaseURL)
	if base == "" {
		return upstreamPricingSnapshot{}, fmt.Errorf("上游地址无效")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/pricing", nil)
	if err != nil {
		return upstreamPricingSnapshot{}, err
	}
	if token := strings.TrimSpace(cfg.AccessToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if uid := strings.TrimSpace(cfg.UserID); uid != "" {
		req.Header.Set("New-Api-User", uid)
	}
	client := &http.Client{Timeout: channelPriceCompareProbeTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return upstreamPricingSnapshot{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return upstreamPricingSnapshot{}, fmt.Errorf("上游返回 %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, channelPriceCompareMaxBody))
	if err != nil {
		return upstreamPricingSnapshot{}, err
	}
	var payload upstreamPricingResponse
	if err := common.Unmarshal(body, &payload); err != nil {
		return upstreamPricingSnapshot{}, err
	}
	if !payload.Success {
		return upstreamPricingSnapshot{}, fmt.Errorf("上游拒绝请求: %s", payload.Message)
	}
	snapshot := upstreamPricingSnapshot{
		GroupRatios:  payload.GroupRatio,
		Models:       make(map[string]upstreamPricingModel, len(payload.Data)),
		QuotaPerUnit: normalizeUpstreamQuotaPerUnit(payload.QuotaPerUnit),
	}
	for _, item := range payload.Data {
		name := strings.TrimSpace(item.ModelName)
		if name == "" || item.QuotaType != 0 ||
			!validUpstreamRatio(item.ModelRatio) ||
			!validUpstreamRatio(item.CompletionRatio) ||
			!validUpstreamRatio(item.CacheRatio) ||
			!validUpstreamRatio(item.CreateCacheRatio) {
			continue
		}
		snapshot.Models[name] = upstreamPricingModel{
			ModelRatio:       *item.ModelRatio,
			CompletionRatio:  *item.CompletionRatio,
			CacheRatio:       *item.CacheRatio,
			CreateCacheRatio: *item.CreateCacheRatio,
		}
	}
	return snapshot, nil
}

func validUpstreamRatio(value *float64) bool {
	return value != nil && validUpstreamRatioValue(*value)
}

func validUpstreamRatioValue(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}
