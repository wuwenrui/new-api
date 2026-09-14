package service

import (
	"math"
	"slices"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/billing_setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
)

// TokenBillingPricing is a current text-token price reference, not a reservation
// or a quote for an entire request (tools, media and cache TTL may cost extra).
type TokenBillingPricing struct {
	Model  *string            `json:"model"`
	Status string             `json:"status"`
	Reason *string            `json:"reason"`
	Rates  []TokenBillingRate `json:"rates"`
}

type TokenBillingRate struct {
	Group      string   `json:"group"`
	Input      float64  `json:"input_quota_per_token"`
	Output     float64  `json:"output_quota_per_token"`
	CacheRead  *float64 `json:"cache_read_quota_per_token"`
	CacheWrite *float64 `json:"cache_write_quota_per_token"`
}

// BillingReferenceNumber excludes values unsafe for JSON/JavaScript consumers.
// Zero is a real price; missing prices must never be represented as zero.
func BillingReferenceNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= common.MaxWalletQuota
}

// GetTokenBillingPricing uses existing SELECTs and configuration readers only.
// Do not replace the ability read with model.GetPricing: its cache refresh can
// INSERT default vendor records.
func GetTokenBillingPricing(token *model.Token, user *model.User, name string) (TokenBillingPricing, error) {
	reason := "model_not_requested"
	result := TokenBillingPricing{Status: "unavailable", Reason: &reason, Rates: []TokenBillingRate{}}
	if name == "" {
		return result, nil
	}
	result.Model = &name
	reason = "model_not_authorized"
	if token.ModelLimitsEnabled && !token.GetModelLimitsMap()[name] {
		return result, nil
	}
	groups := []string{user.Group}
	if token.Group != "" {
		if !GroupInUserUsableGroups(user.Group, token.Group) {
			return result, nil
		}
		groups = []string{token.Group}
	}
	if groups[0] == "auto" {
		configured, err := token.GetAutoGroups()
		if err != nil {
			reason = "invalid_group_configuration"
			return result, nil
		}
		groups = GetUserAutoGroup(user.Group)
		if len(configured) > 0 {
			groups = FilterUserTokenAutoGroups(user.Group, configured)
		}
	}
	abilities, err := model.GetAllEnableAbilityWithChannels()
	if err != nil {
		return result, err
	}
	eligible := make(map[string]bool)
	unsupported := false
	for _, ability := range abilities {
		if ability.Model != name || !slices.Contains(groups, ability.Group) || !ratio_setting.ContainsGroupRatio(ability.Group) {
			continue
		}
		eligible[ability.Group] = true
		// Explicit allowlist: unknown/custom/plugin/task adapters cannot establish
		// unambiguous standard text-token pricing. Never expose channel information.
		switch ability.ChannelType {
		case constant.ChannelTypeOpenAI, constant.ChannelTypeAzure, constant.ChannelTypeAnthropic,
			constant.ChannelTypeDeepSeek, constant.ChannelTypeNewAPI:
		default:
			unsupported = true
		}
	}
	if len(eligible) == 0 {
		return result, nil
	}
	if len(eligible) > 100 {
		reason = "invalid_group_configuration"
		return result, nil
	}
	if unsupported {
		reason = "unsupported_pricing"
		return result, nil
	}

	// Capture the same authoritative scalar readers as ModelPriceHelper under
	// the pricing snapshot lock, including the current peak multiplier. Checking
	// the actual ratio map avoids SelfUseMode's guessed default price.
	var input, output, cache, peak float64
	var configured, cacheConfigured, fixed bool
	var mode string
	ratio_setting.ReadPricingSnapshot(func() {
		var key string
		input, _, key = ratio_setting.GetModelRatio(name)
		_, configured = ratio_setting.GetModelRatioCopy()[key]
		output = ratio_setting.GetCompletionRatio(name)
		cache, cacheConfigured = ratio_setting.GetCacheRatio(name)
		_, fixed = ratio_setting.GetModelPrice(name, false)
		mode = billing_setting.GetBillingMode(name)
		peak, _ = ratio_setting.GetPeakMultiplier(name)
	})
	if mode != billing_setting.BillingModeRatio {
		reason = "unsupported_billing_mode"
		return result, nil
	}
	if fixed {
		reason = "unsupported_pricing"
		return result, nil
	}
	if !configured {
		reason = "pricing_not_configured"
		return result, nil
	}
	reason = "invalid_pricing"
	if !BillingReferenceNumber(input) || !BillingReferenceNumber(output) || !BillingReferenceNumber(peak) || (cacheConfigured && !BillingReferenceNumber(cache)) {
		return result, nil
	}
	rates := make([]TokenBillingRate, 0, len(eligible))
	for _, group := range groups {
		if !eligible[group] {
			continue
		}
		groupRatio := GetUserGroupRatio(user.Group, group)
		if !BillingReferenceNumber(groupRatio) {
			return result, nil
		}
		rate := TokenBillingRate{Group: group, Input: input * peak * groupRatio}
		rate.Output = rate.Input * output
		if cacheConfigured {
			value := rate.Input * cache
			rate.CacheRead = &value
		}
		// Cache creation has distinct 5m/1h rates; the v1 singular field is ambiguous.
		if !BillingReferenceNumber(rate.Input) || !BillingReferenceNumber(rate.Output) || (rate.CacheRead != nil && !BillingReferenceNumber(*rate.CacheRead)) {
			return result, nil
		}
		rates = append(rates, rate)
	}
	result.Status, result.Reason, result.Rates = "available", nil, rates
	return result, nil
}
