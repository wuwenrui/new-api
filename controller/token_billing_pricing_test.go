package controller

import (
	"testing"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTokenBillingAutoAuthorization(t *testing.T) {
	engine, _, token := setupBillingEndpoint(t)
	require.NoError(t, model.DB.Model(token).Updates(map[string]any{"group": "auto", "auto_groups": `["vip","default"]`}).Error)
	result := requestBilling(t, engine, "?model=billing-test", "Bearer sk-billingfixture", 200)
	require.Len(t, result.Data.Pricing.Rates, 2)
	assert.Equal(t, "vip", result.Data.Pricing.Rates[0].Group)
	assert.Equal(t, 1.0, result.Data.Pricing.Rates[0].Input)
	assert.Equal(t, "default", result.Data.Pricing.Rates[1].Group)
	assert.Equal(t, 2.0, result.Data.Pricing.Rates[1].Input)
	require.NoError(t, model.DB.Model(token).Update("auto_groups", `["vip","removed"]`).Error)
	result = requestBilling(t, engine, "?model=billing-test", "Bearer sk-billingfixture", 200)
	require.Len(t, result.Data.Pricing.Rates, 1)
	assert.Equal(t, "vip", result.Data.Pricing.Rates[0].Group)
	require.NoError(t, model.DB.Model(token).Update("auto_groups", `broken`).Error)
	result = requestBilling(t, engine, "?model=billing-test", "Bearer sk-billingfixture", 200)
	require.NotNil(t, result.Data.Pricing.Reason)
	assert.Equal(t, "invalid_group_configuration", *result.Data.Pricing.Reason)
	require.NoError(t, model.DB.Model(token).Updates(map[string]any{"auto_groups": "", "model_limits_enabled": true, "model_limits": "billing-test"}).Error)
	for _, name := range []string{"Billing-test", "billing-test-suffix", "zero-test", "unknown-model"} {
		result = requestBilling(t, engine, "?model="+name, "Bearer sk-billingfixture", 200)
		require.NotNil(t, result.Data.Pricing.Reason)
		assert.Equal(t, "model_not_authorized", *result.Data.Pricing.Reason)
		assert.Empty(t, result.Data.Pricing.Rates)
	}
	result = requestBilling(t, engine, "?model=billing-test", "Bearer sk-billingfixture", 200)
	require.Len(t, result.Data.Pricing.Rates, 2)
}

func TestTokenBillingUnavailableAndSafePrices(t *testing.T) {
	tests := []struct {
		name, model, reason string
		configure           func(*testing.T)
	}{
		{name: "missing ratio even in self use", model: "missing-test", reason: "pricing_not_configured", configure: func(t *testing.T) { operation_setting.SelfUseModeEnabled = true }},
		{name: "expression", model: "billing-test", reason: "unsupported_billing_mode", configure: func(t *testing.T) {
			require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{"billing_setting.billing_mode": `{"billing-test":"tiered_expr"}`, "billing_setting.billing_expr": `{"billing-test":"tier(\"base\", p * 2)"}`}))
		}},
		{name: "plugin mode", model: "billing-test", reason: "unsupported_billing_mode", configure: func(t *testing.T) {
			require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{"billing_setting.billing_mode": `{"billing-test":"plugin"}`}))
		}},
		{name: "per request", model: "billing-test", reason: "unsupported_pricing", configure: func(t *testing.T) {
			require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(`{"billing-test":1}`))
		}},
		{name: "unknown channel", model: "billing-test", reason: "unsupported_pricing", configure: func(t *testing.T) {
			require.NoError(t, model.DB.Model(&model.Channel{}).Where("id = ?", 903).Update("type", 999).Error)
		}},
		{name: "negative", model: "billing-test", reason: "invalid_pricing", configure: func(t *testing.T) {
			require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"billing-test":-1}`))
		}},
		{name: "overflow product", model: "billing-test", reason: "invalid_pricing", configure: func(t *testing.T) {
			require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"billing-test":9007199254740991}`))
		}},
		{name: "unsafe cache", model: "billing-test", reason: "invalid_pricing", configure: func(t *testing.T) {
			require.NoError(t, ratio_setting.UpdateCacheRatioByJSONString(`{"billing-test":-1}`))
		}},
		{name: "zero is valid", model: "zero-test"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			engine, _, _ := setupBillingEndpoint(t)
			if test.configure != nil {
				test.configure(t)
			}
			result := requestBilling(t, engine, "?model="+test.model, "Bearer sk-billingfixture", 200)
			require.True(t, result.Success)
			if test.reason != "" {
				assert.Equal(t, "unavailable", result.Data.Pricing.Status)
				require.NotNil(t, result.Data.Pricing.Reason)
				assert.Equal(t, test.reason, *result.Data.Pricing.Reason)
				assert.NotNil(t, result.Data.Pricing.Rates)
				assert.Empty(t, result.Data.Pricing.Rates)
			} else {
				assert.Equal(t, "available", result.Data.Pricing.Status)
				require.Len(t, result.Data.Pricing.Rates, 1)
				assert.Zero(t, result.Data.Pricing.Rates[0].Input)
				assert.Zero(t, result.Data.Pricing.Rates[0].Output)
				assert.Nil(t, result.Data.Pricing.Rates[0].CacheRead)
			}
		})
	}
}

func TestTokenBillingPeakAndInheritedGroup(t *testing.T) {
	engine, user, token := setupBillingEndpoint(t)
	require.NoError(t, model.DB.Model(token).Update("group", "").Error)
	require.NoError(t, model.DB.Model(user).Update("group", "vip").Error)
	require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{
		"peak_ratio_setting.enabled": "true", "peak_ratio_setting.weekend_enabled": "true",
		"peak_ratio_setting.multiplier": "2", "peak_ratio_setting.models": `["billing-test"]`,
		"peak_ratio_setting.windows": `[{"start":"00:00","end":"12:00"},{"start":"12:00","end":"00:00"}]`,
	}))
	ratio_setting.ReloadPeakRatioFromSetting()
	result := requestBilling(t, engine, "?model=billing-test", "Bearer sk-billingfixture", 200)
	require.Len(t, result.Data.Pricing.Rates, 1)
	assert.Equal(t, "vip", result.Data.Pricing.Rates[0].Group)
	// Actual user group has no default→vip override: 2 model * 2 peak * 4 vip.
	assert.Equal(t, 16.0, result.Data.Pricing.Rates[0].Input)
	assert.Equal(t, 48.0, result.Data.Pricing.Rates[0].Output)
}
