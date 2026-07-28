package service

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/setting/system_setting"
)

// WebhookPayload webhook 通知的负载数据
type WebhookPayload struct {
	Type      string        `json:"type"`
	Title     string        `json:"title"`
	Content   string        `json:"content"`
	Values    []interface{} `json:"values,omitempty"`
	Timestamp int64         `json:"timestamp"`
}

// generateSignature 生成 webhook 签名
func generateSignature(secret string, payload []byte) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write(payload)
	return hex.EncodeToString(h.Sum(nil))
}

func renderNotifyContent(content string, values []interface{}) string {
	for _, value := range values {
		content = strings.Replace(content, dto.ContentValueParam, fmt.Sprintf("%v", value), 1)
	}
	return content
}

func isServerChanWebhookURL(webhookURL string) bool {
	parsed, err := url.Parse(webhookURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	if !(strings.HasSuffix(host, "ftqq.com") || strings.HasSuffix(host, "ft07.com")) {
		return false
	}
	return strings.Contains(parsed.Path, ".send")
}

func buildWebhookBody(webhookURL string, data dto.Notify) ([]byte, string, error) {
	content := renderNotifyContent(data.Content, data.Values)
	if isServerChanWebhookURL(webhookURL) {
		values := url.Values{}
		values.Set("title", data.Title)
		values.Set("text", data.Title)
		values.Set("desp", content)
		return []byte(values.Encode()), "application/x-www-form-urlencoded", nil
	}

	payload := WebhookPayload{
		Type:      data.Type,
		Title:     data.Title,
		Content:   content,
		Values:    data.Values,
		Timestamp: time.Now().Unix(),
	}

	// 序列化负载
	payloadBytes, err := common.Marshal(payload)
	if err != nil {
		return nil, "", fmt.Errorf("failed to marshal webhook payload: %v", err)
	}
	return payloadBytes, "application/json", nil
}

// SendWebhookNotify 发送 webhook 通知
func SendWebhookNotify(webhookURL string, secret string, data dto.Notify) error {
	payloadBytes, contentType, err := buildWebhookBody(webhookURL, data)
	if err != nil {
		return err
	}

	// 创建 HTTP 请求
	var req *http.Request
	var resp *http.Response

	if system_setting.EnableWorker() {
		// 构建worker请求数据
		workerReq := &WorkerRequest{
			URL:    webhookURL,
			Key:    system_setting.WorkerValidKey,
			Method: http.MethodPost,
			Headers: map[string]string{
				"Content-Type": contentType,
			},
			Body: payloadBytes,
		}

		// 如果有secret，添加签名到headers
		if secret != "" {
			signature := generateSignature(secret, payloadBytes)
			workerReq.Headers["X-Webhook-Signature"] = signature
			workerReq.Headers["Authorization"] = "Bearer " + secret
		}

		resp, err = DoWorkerRequest(workerReq)
		if err != nil {
			return fmt.Errorf("failed to send webhook request through worker: %v", err)
		}
		defer resp.Body.Close()

		// 检查响应状态
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("webhook request failed with status code: %d", resp.StatusCode)
		}
	} else {
		// SSRF防护：验证Webhook URL（非Worker模式）
		if err := ValidateSSRFProtectedFetchURL(webhookURL); err != nil {
			return fmt.Errorf("request reject: %v", err)
		}

		req, err = http.NewRequest(http.MethodPost, webhookURL, bytes.NewBuffer(payloadBytes))
		if err != nil {
			return fmt.Errorf("failed to create webhook request: %v", err)
		}

		// 设置请求头
		req.Header.Set("Content-Type", contentType)

		// 如果有 secret，生成签名
		if secret != "" {
			signature := generateSignature(secret, payloadBytes)
			req.Header.Set("X-Webhook-Signature", signature)
		}

		// 发送请求
		client := GetSSRFProtectedHTTPClient()
		resp, err = client.Do(req)
		if err != nil {
			return fmt.Errorf("failed to send webhook request: %v", err)
		}
		defer resp.Body.Close()

		// 检查响应状态
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("webhook request failed with status code: %d", resp.StatusCode)
		}
	}

	return nil
}
