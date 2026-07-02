package controller

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"

	"github.com/gin-gonic/gin"
)

const (
	newAPIProbeTimeoutSeconds = 15
	newAPIProbeMaxBodyBytes   = 10 << 20 // 10MB
	newAPIProbePricingPath    = "/api/pricing"
)

type NewAPIProbeRequest struct {
	BaseURL     string `json:"base_url"`
	AccessToken string `json:"access_token"`
	UserID      string `json:"user_id"`
}

type NewAPIProbeModel struct {
	ModelName              string   `json:"model_name"`
	QuotaType              int      `json:"quota_type"`
	ModelRatio             float64  `json:"model_ratio"`
	ModelPrice             float64  `json:"model_price"`
	CompletionRatio        float64  `json:"completion_ratio"`
	CacheRatio             float64  `json:"cache_ratio"`
	CreateCacheRatio       float64  `json:"create_cache_ratio"`
	ImageRatio             float64  `json:"image_ratio"`
	AudioRatio             float64  `json:"audio_ratio"`
	AudioCompletionRatio   float64  `json:"audio_completion_ratio"`
	EnableGroups           []string `json:"enable_groups"`
	SupportedEndpointTypes []string `json:"supported_endpoint_types"`
}

type newAPIProbePricingResponse struct {
	Success     bool               `json:"success"`
	Message     string             `json:"message"`
	Data        []NewAPIProbeModel `json:"data"`
	GroupRatio  map[string]float64 `json:"group_ratio"`
	UsableGroup map[string]string  `json:"usable_group"`
}

// NewAPIProbeRateInfo 上游站点的货币展示与汇率设置（取自 /api/status）
type NewAPIProbeRateInfo struct {
	QuotaDisplayType string  `json:"quota_display_type"`
	USDExchangeRate  float64 `json:"usd_exchange_rate"`
	Price            float64 `json:"price"`
}

func fetchUpstreamRateInfo(client *http.Client, baseURL string) *NewAPIProbeRateInfo {
	resp, err := client.Get(baseURL + "/api/status")
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, newAPIProbeMaxBodyBytes))
	if err != nil {
		return nil
	}
	var status struct {
		Data NewAPIProbeRateInfo `json:"data"`
	}
	if err := common.Unmarshal(body, &status); err != nil {
		return nil
	}
	return &status.Data
}

func normalizeProbeBaseURL(raw string) (string, error) {
	raw = strings.TrimSpace(strings.TrimRight(raw, "/"))
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("地址解析失败: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("地址必须以 http:// 或 https:// 开头")
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("地址缺少主机名")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

// ProbeNewAPIUpstream 拉取上游 new-api 站点的 /api/pricing，
// 返回模型、分组倍率与分组描述，用于「接入 NewAPI 渠道」向导。
func ProbeNewAPIUpstream(c *gin.Context) {
	var req NewAPIProbeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "请求参数格式错误"})
		return
	}

	baseURL, err := normalizeProbeBaseURL(req.BaseURL)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": err.Error()})
		return
	}

	httpReq, err := http.NewRequestWithContext(
		c.Request.Context(), http.MethodGet, baseURL+newAPIProbePricingPath, nil,
	)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "构建请求失败: " + err.Error()})
		return
	}
	if token := strings.TrimSpace(req.AccessToken); token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+token)
	}
	if userID := strings.TrimSpace(req.UserID); userID != "" {
		httpReq.Header.Set("New-Api-User", userID)
	}

	transport := &http.Transport{}
	if common.TLSInsecureSkipVerify {
		transport.TLSClientConfig = common.InsecureTLSConfig
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   newAPIProbeTimeoutSeconds * time.Second,
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "连接上游失败: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"message": fmt.Sprintf("上游返回 %s，请检查地址；若站点价格页需要登录，请提供系统访问令牌和用户 ID", resp.Status),
		})
		return
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, newAPIProbeMaxBodyBytes))
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "读取上游响应失败: " + err.Error()})
		return
	}

	var pricing newAPIProbePricingResponse
	if err := common.Unmarshal(body, &pricing); err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "上游响应不是有效的 new-api 价格数据: " + err.Error()})
		return
	}
	if !pricing.Success {
		msg := pricing.Message
		if msg == "" {
			msg = "上游返回失败状态"
		}
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "上游拒绝请求: " + msg})
		return
	}
	if len(pricing.Data) == 0 {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "上游未返回任何模型，可能价格页需要登录，请提供系统访问令牌和用户 ID"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data": gin.H{
			"base_url":     baseURL,
			"models":       pricing.Data,
			"group_ratio":  pricing.GroupRatio,
			"usable_group": pricing.UsableGroup,
			"rate_info":    fetchUpstreamRateInfo(client, baseURL),
		},
	})
}
