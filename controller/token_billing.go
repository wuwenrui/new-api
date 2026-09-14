package controller

import (
	"net/http"
	"net/url"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
)

// GetTokenBilling returns only the authenticated owner's wallet, token limit,
// and current authorized text-token price reference. It performs no DB writes.
func GetTokenBilling(c *gin.Context) {
	c.Header("Cache-Control", "no-store, private")
	query, err := url.ParseQuery(c.Request.URL.RawQuery)
	name := query.Get("model")
	invalid := err != nil || len(query["model"]) > 1 || len(name) > 255 || !utf8.ValidString(name)
	for key := range query {
		if key != "model" {
			invalid = true
		}
	}
	for _, char := range name {
		if unicode.IsControl(char) || unicode.IsSpace(char) {
			invalid = true
		}
	}
	if _, present := query["model"]; present && name == "" {
		invalid = true
	}
	if invalid {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "code": "invalid_model", "message": "Expected one optional exact model name"})
		return
	}
	userID, tokenID := c.GetInt("id"), c.GetInt("token_id")
	if userID <= 0 || tokenID <= 0 {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "code": "unauthorized", "message": "Authentication required"})
		return
	}
	token, err := model.GetTokenByIds(tokenID, userID)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "code": "unauthorized", "message": "Token unavailable"})
		return
	}
	// Recheck DB state after read-only middleware's potentially cached identity.
	if token.Status == common.TokenStatusDisabled || token.Key != c.GetString("token_key") {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "code": "unauthorized", "message": "Token unavailable"})
		return
	}
	user, err := model.GetUserById(userID, false)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "code": "billing_metadata_unavailable", "message": "Billing metadata unavailable"})
		return
	}
	if user.Status != common.UserStatusEnabled {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "code": "unauthorized", "message": "Account unavailable"})
		return
	}
	unit := common.QuotaPerUnit
	displayType := operation_setting.GetQuotaDisplayType()
	exchangeRate := 1.0
	switch displayType {
	case operation_setting.QuotaDisplayTypeCNY:
		exchangeRate = operation_setting.USDExchangeRate
	case operation_setting.QuotaDisplayTypeUSD, operation_setting.QuotaDisplayTypeTokens:
	default:
		// CUSTOM has no v1 currency symbol. Use explicit canonical USD, never label
		// custom amounts as CNY or guess a currency based on the symbol.
		displayType = operation_setting.QuotaDisplayTypeUSD
	}
	if !service.BillingReferenceNumber(unit) || unit == 0 || !service.BillingReferenceNumber(exchangeRate) || exchangeRate == 0 ||
		!service.BillingReferenceNumber(float64(user.Quota)) || !service.BillingReferenceNumber(float64(token.UsedQuota)) ||
		(!token.UnlimitedQuota && !service.BillingReferenceNumber(float64(token.RemainQuota))) {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "code": "billing_metadata_unavailable", "message": "Billing metadata unavailable"})
		return
	}
	pricing, err := service.GetTokenBillingPricing(token, user, name)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "code": "billing_metadata_unavailable", "message": "Billing metadata unavailable"})
		return
	}
	var remaining *int
	if !token.UnlimitedQuota {
		remaining = &token.RemainQuota
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{
		"version": 1, "observed_at": time.Now().Unix(), "quota_per_unit": unit,
		"display": gin.H{"type": displayType, "exchange_rate": exchangeRate},
		"account": gin.H{"remaining_quota": user.Quota},
		"token":   gin.H{"remaining_quota": remaining, "used_quota": token.UsedQuota, "unlimited": token.UnlimitedQuota},
		"pricing": pricing,
	}})
}
