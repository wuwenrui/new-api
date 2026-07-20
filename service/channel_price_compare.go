package service

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
)

const (
	channelPriceCompareProbeTimeout = 15 * time.Second
	channelPriceCompareMaxBody      = 10 << 20 // 10MB
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
	GroupRatios map[string]float64
	Models      map[string]upstreamPricingModel
}

type upstreamPricingItem struct {
	ModelName        string  `json:"model_name"`
	ModelRatio       float64 `json:"model_ratio"`
	CompletionRatio  float64 `json:"completion_ratio"`
	CacheRatio       float64 `json:"cache_ratio"`
	CreateCacheRatio float64 `json:"create_cache_ratio"`
}

type upstreamPricingResponse struct {
	Success    bool                  `json:"success"`
	Message    string                `json:"message"`
	Data       []upstreamPricingItem `json:"data"`
	GroupRatio map[string]float64    `json:"group_ratio"`
}

// ChannelPriceCompareChannel 单个渠道在某模型下的上游价、本地价与盈利率（单位美元 / 1M tokens）
type ChannelPriceCompareChannel struct {
	ChannelID          int     `json:"channel_id"`
	ChannelName        string  `json:"channel_name"`
	UpstreamBase       string  `json:"upstream_base"`
	UpstreamGroup      string  `json:"upstream_group"`
	Priority           int64   `json:"priority"`
	Status             string  `json:"status"`        // ok（数据完整）/ unknown（上游价缺失）
	StatusReason       string  `json:"status_reason"` // status=unknown 时的原因
	LocalInput         float64 `json:"local_input"`
	LocalOutput        float64 `json:"local_output"`
	LocalCacheRead     float64 `json:"local_cache_read"`
	LocalCacheWrite    float64 `json:"local_cache_write"`
	UpstreamInput      float64 `json:"upstream_input"`
	UpstreamOutput     float64 `json:"upstream_output"`
	UpstreamCacheRead  float64 `json:"upstream_cache_read"`
	UpstreamCacheWrite float64 `json:"upstream_cache_write"`
	MarginInput        float64 `json:"margin_input"`  // 输入盈利率 %
	MarginOutput       float64 `json:"margin_output"` // 输出盈利率 %
}

// ChannelPriceCompareModelRow 一个模型及其候选渠道（按优先级降序，与实际选路一致）
type ChannelPriceCompareModelRow struct {
	ModelName string                       `json:"model_name"`
	Channels  []ChannelPriceCompareChannel `json:"channels"`
}

// ChannelPriceCompareReport 面板返回体
type ChannelPriceCompareReport struct {
	GeneratedAt int64                         `json:"generated_at"`
	LocalGroup  string                        `json:"local_group"`
	Models      []ChannelPriceCompareModelRow `json:"models"`
	ProbeErrors map[string]string             `json:"probe_errors"` // base_url -> 探测错误
}

// BuildChannelPriceCompareReport 聚合本地启用渠道 + 实时探测各上游定价，
// 按模型分组给出上游价、本地价与盈利率。localGroup 为本地售价使用的分组，默认 default。
func BuildChannelPriceCompareReport(ctx context.Context, localGroup string) (ChannelPriceCompareReport, error) {
	localGroup = strings.TrimSpace(localGroup)
	if localGroup == "" {
		localGroup = "default"
	}
	localGroupRatio := ratio_setting.GetGroupRatio(localGroup)

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

	var channels []*model.Channel
	if err := model.DB.Model(&model.Channel{}).Omit("key").
		Where("status = ?", common.ChannelStatusEnabled).
		Find(&channels).Error; err != nil {
		return ChannelPriceCompareReport{}, err
	}

	snapshots := make(map[string]upstreamPricingSnapshot)
	probeErrors := make(map[string]string)
	modelIndex := make(map[string]int)
	rows := make([]ChannelPriceCompareModelRow, 0)

	for _, channel := range channels {
		if channel == nil {
			continue
		}
		base := normalizeUpstreamBaseURL(channel.GetBaseURL())
		if base == "" {
			continue // 无上游地址的渠道不参与比价
		}
		cfg, ok := configByBase[base]
		if !ok {
			continue // 未配置探测凭据的上游跳过
		}
		snapshot, probed := snapshots[base]
		if !probed {
			s, perr := probeUpstreamPricing(ctx, cfg)
			if perr != nil {
				probeErrors[base] = perr.Error()
			}
			snapshot = s
			snapshots[base] = s // 无论成败都记，避免重复探测同一上游
		}
		if len(snapshot.Models) == 0 {
			continue
		}
		upstreamGroup := strings.TrimSpace(channel.GetOtherSettings().PACUpstreamGroup)

		for _, modelName := range channel.GetModels() {
			modelName = strings.TrimSpace(modelName)
			if modelName == "" {
				continue
			}
			row := buildChannelPriceCompareRow(channel, base, upstreamGroup, modelName, snapshot, localGroupRatio)
			idx, exists := modelIndex[modelName]
			if !exists {
				idx = len(rows)
				modelIndex[modelName] = idx
				rows = append(rows, ChannelPriceCompareModelRow{ModelName: modelName})
			}
			rows[idx].Channels = append(rows[idx].Channels, row)
		}
	}

	for i := range rows {
		sort.SliceStable(rows[i].Channels, func(a, b int) bool {
			return rows[i].Channels[a].Priority > rows[i].Channels[b].Priority
		})
	}
	sort.SliceStable(rows, func(a, b int) bool {
		return rows[a].ModelName < rows[b].ModelName
	})

	return ChannelPriceCompareReport{
		GeneratedAt: time.Now().Unix(),
		LocalGroup:  localGroup,
		Models:      rows,
		ProbeErrors: probeErrors,
	}, nil
}

func buildChannelPriceCompareRow(channel *model.Channel, base string, upstreamGroup string, modelName string, snapshot upstreamPricingSnapshot, localGroupRatio float64) ChannelPriceCompareChannel {
	row := ChannelPriceCompareChannel{
		ChannelID:     channel.Id,
		ChannelName:   channel.Name,
		UpstreamBase:  base,
		UpstreamGroup: upstreamGroup,
		Priority:      channelPriorityValue(channel),
	}

	if localModelRatio, ok, _ := ratio_setting.GetModelRatio(modelName); ok && localModelRatio > 0 {
		localCompletion := ratio_setting.GetCompletionRatio(modelName)
		localCacheRead, _ := ratio_setting.GetCacheRatio(modelName)
		localCacheWrite, _ := ratio_setting.GetCreateCacheRatio(modelName)
		row.LocalInput = pricePerMillion(localModelRatio, localGroupRatio)
		row.LocalOutput = pricePerMillion(localModelRatio*localCompletion, localGroupRatio)
		row.LocalCacheRead = pricePerMillion(localModelRatio*localCacheRead, localGroupRatio)
		row.LocalCacheWrite = pricePerMillion(localModelRatio*localCacheWrite, localGroupRatio)
	}

	if upstreamGroup == "" {
		row.Status = "unknown"
		row.StatusReason = "该渠道未标注上游分组（pac_upstream_group）"
		return row
	}
	upGroupRatio, ok := snapshot.GroupRatios[upstreamGroup]
	if !ok || upGroupRatio <= 0 {
		row.Status = "unknown"
		row.StatusReason = "上游未返回该分组倍率"
		return row
	}
	upModel, ok := snapshot.Models[modelName]
	if !ok || upModel.ModelRatio <= 0 {
		row.Status = "unknown"
		row.StatusReason = "上游无该模型价格"
		return row
	}

	row.UpstreamInput = pricePerMillion(upModel.ModelRatio, upGroupRatio)
	row.UpstreamOutput = pricePerMillion(upModel.ModelRatio*upModel.CompletionRatio, upGroupRatio)
	row.UpstreamCacheRead = pricePerMillion(upModel.ModelRatio*upModel.CacheRatio, upGroupRatio)
	row.UpstreamCacheWrite = pricePerMillion(upModel.ModelRatio*upModel.CreateCacheRatio, upGroupRatio)
	row.MarginInput = grossMargin(row.LocalInput, row.UpstreamInput)
	row.MarginOutput = grossMargin(row.LocalOutput, row.UpstreamOutput)
	row.Status = "ok"
	return row
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

func probeUpstreamPricing(ctx context.Context, cfg UpstreamProbeConfig) (upstreamPricingSnapshot, error) {
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
		GroupRatios: payload.GroupRatio,
		Models:      make(map[string]upstreamPricingModel, len(payload.Data)),
	}
	for _, item := range payload.Data {
		name := strings.TrimSpace(item.ModelName)
		if name == "" {
			continue
		}
		snapshot.Models[name] = upstreamPricingModel{
			ModelRatio:       item.ModelRatio,
			CompletionRatio:  item.CompletionRatio,
			CacheRatio:       item.CacheRatio,
			CreateCacheRatio: item.CreateCacheRatio,
		}
	}
	return snapshot, nil
}
