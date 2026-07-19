package controller

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

const wechatRelayRequestBodyLimit = 15 * 1024 * 1024

type wechatRelayRequest struct {
	KeyID                string         `json:"keyId"`
	EncryptedCredentials string         `json:"encryptedCredentials"`
	Operation            map[string]any `json:"operation"`
}

func requireWeChatAdvancedSubscription(c *gin.Context) bool {
	active, err := model.UserCanAccessSubscriptionFeature(
		c.GetInt("id"),
		model.SubscriptionFeatureWechatBridge,
	)
	if err != nil {
		writeWeChatRelayError(c, &service.WeChatRelayError{
			Code:      "entitlement_check_failed",
			Category:  "wechat_unavailable",
			Message:   "暂时无法核对微信高级功能订阅状态，请稍后重试",
			Retryable: true,
		})
		return false
	}
	if active {
		return true
	}
	c.JSON(http.StatusForbidden, gin.H{
		"success": false,
		"message": "公众号文章需要开通微信高级功能订阅后使用",
		"error": gin.H{
			"code":      "subscription_required",
			"category":  "subscription_required",
			"message":   "公众号文章需要开通微信高级功能订阅后使用",
			"retryable": false,
		},
	})
	return false
}

func GetWeChatOfficialAccountRelayPublicKey(c *gin.Context) {
	if !requireWeChatAdvancedSubscription(c) {
		return
	}
	publicKey, relayErr := service.GetWeChatRelayPublicKey(c.GetInt("id"), c.GetInt("token_id"))
	if relayErr != nil {
		writeWeChatRelayError(c, relayErr)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    publicKey,
	})
}

func RelayWeChatOfficialAccount(c *gin.Context) {
	if !requireWeChatAdvancedSubscription(c) {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, wechatRelayRequestBodyLimit)
	var request wechatRelayRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"success": false,
			"message": "公众号 relay 请求格式无效或超过大小限制",
			"error": gin.H{
				"code":      "invalid_request",
				"category":  "invalid_request",
				"message":   "公众号 relay 请求格式无效或超过大小限制",
				"retryable": false,
			},
		})
		return
	}
	if request.Operation == nil {
		request.Operation = map[string]any{}
	}
	data, relayErr := service.ExecuteWeChatOfficialAccountRelay(
		c.Request.Context(),
		c.GetInt("id"),
		c.GetInt("token_id"),
		request.KeyID,
		request.EncryptedCredentials,
		request.Operation,
	)
	if relayErr != nil {
		writeWeChatRelayError(c, relayErr)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    data,
	})
}

func writeWeChatRelayError(c *gin.Context, relayErr *service.WeChatRelayError) {
	status := http.StatusBadRequest
	switch relayErr.Category {
	case "network_timeout", "wechat_unavailable":
		status = http.StatusServiceUnavailable
	case "credential_invalid":
		status = http.StatusUnauthorized
	case "ip_not_whitelisted", "material_permission_denied", "draft_permission_denied":
		status = http.StatusForbidden
	case "rate_limited":
		status = http.StatusTooManyRequests
	}
	c.JSON(status, gin.H{
		"success": false,
		"message": relayErr.Message,
		"error":   relayErr,
	})
}
