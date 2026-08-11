package service

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

// pacBalanceQueryTimeout 查询 packyapi 账户余额的超时（跨境偶发卡顿，参照定价探测）。
const pacBalanceQueryTimeout = 15 * time.Second

// pacBalanceUpstreamHostMatch 判定上游 base_url 是否为 packyapi（余额查询目标上游）。
// 独立为变量便于测试注入本地 httptest 地址。
var pacBalanceUpstreamHostMatch = func(baseURL string) bool {
	return strings.Contains(normalizeUpstreamBaseURL(baseURL), "packyapi.com")
}

// pacUserSelfResponse packyapi /api/user/self 的响应（new-api 系上游标准结构）。
type pacUserSelfResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    struct {
		Quota int64 `json:"quota"`
	} `json:"data"`
}

// RefreshPACChannelBalances 从 UpstreamProbeConfigs 读取 packyapi 配置，
// 查询 packyapi 账户余额（GET {base}/api/user/self → data.quota，quota/QuotaPerUnit = USD），
// 并把余额刷新到所有 PAC 相关渠道（名称 pac-* 或 base_url 含 packyapi.com）的 balance 字段。
// 未配置 packyapi 凭据时静默返回 nil；查询或落库失败返回错误，由调用方记录日志。
// 余额查询使用系统访问令牌 + 用户 ID（New-Api-User），与渠道 key 无关。
func RefreshPACChannelBalances(ctx context.Context) error {
	configs, err := LoadUpstreamProbeConfigs()
	if err != nil {
		return err
	}
	var packyConfig *UpstreamProbeConfig
	for i := range configs {
		if pacBalanceUpstreamHostMatch(normalizeUpstreamBaseURL(configs[i].BaseURL)) {
			packyConfig = &configs[i]
			break
		}
	}
	if packyConfig == nil || strings.TrimSpace(packyConfig.AccessToken) == "" || strings.TrimSpace(packyConfig.UserID) == "" {
		return nil
	}

	balance, err := queryPACUserSelfBalance(ctx, *packyConfig)
	if err != nil {
		return fmt.Errorf("查询 packyapi 账户余额失败: %w", err)
	}
	if err := updatePACChannelBalances(balance); err != nil {
		return fmt.Errorf("刷新 PAC 渠道余额失败: %w", err)
	}
	return nil
}

// queryPACUserSelfBalance 调用 packyapi 的 new-api 风格余额接口。
// 必须携带浏览器 UA（packyapi 对管理面接口有 Cloudflare 防护）与 New-Api-User 请求头。
func queryPACUserSelfBalance(ctx context.Context, cfg UpstreamProbeConfig) (float64, error) {
	base := normalizeUpstreamBaseURL(cfg.BaseURL)
	if base == "" {
		return 0, fmt.Errorf("上游地址无效")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/user/self", nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(cfg.AccessToken))
	if uid := strings.TrimSpace(cfg.UserID); uid != "" {
		req.Header.Set("New-Api-User", uid)
	}

	client := &http.Client{Timeout: pacBalanceQueryTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("上游返回 %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return 0, err
	}
	var payload pacUserSelfResponse
	if err := common.Unmarshal(body, &payload); err != nil {
		return 0, err
	}
	if !payload.Success {
		return 0, fmt.Errorf("上游拒绝请求: %s", payload.Message)
	}
	return float64(payload.Data.Quota) / common.QuotaPerUnit, nil
}

// updatePACChannelBalances 把账户余额写入所有 PAC 相关渠道（名称 pac-* 或 base_url 含 packyapi.com），
// 复用 UpdateBalance 同时刷新 balance 与 balance_updated_time，使低余额告警状态机可感知余额。
func updatePACChannelBalances(balance float64) error {
	var channels []*model.Channel
	if err := model.DB.Model(&model.Channel{}).
		Where("(name LIKE ? OR base_url LIKE ?)", "pac-%", "%packyapi.com%").
		Find(&channels).Error; err != nil {
		return err
	}
	for _, channel := range channels {
		if channel == nil {
			continue
		}
		channel.UpdateBalance(balance)
	}
	return nil
}
