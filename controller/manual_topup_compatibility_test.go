package controller

import (
	"errors"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestManualTopUpPreservesCustomDisplayAndUnusedDiscounts(t *testing.T) {
	engine, _, _ := setupTokenManualTopUp(t)
	operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeCustom
	options := requestTokenManual(t, engine, "GET", "/options", "", 200)["data"].(map[string]interface{})
	assert.Equal(t, float64(1), options["amount_step"])
	for _, discount := range []float64{0, -1} {
		operation_setting.GetPaymentSetting().AmountDiscount = map[int]float64{10: discount}
		quote := requestTokenManual(t, engine, "POST", "/quote", `{"amount":10,"payment_method":"manual_wechat"}`, 200)["data"].(map[string]interface{})
		// The existing site ignores nonpositive discounts; display customizations
		// do not alter stored recharge units or the CNY collection price.
		assert.Equal(t, float64(45), quote["money"])
		assert.Equal(t, 10*common.QuotaPerUnit, quote["expected_quota"])
		assert.Equal(t, "CNY", quote["payment_currency"])
	}
}

func TestManualTopUpInsertFailureIsNotDefiniteClientRejection(t *testing.T) {
	engine, _, _ := setupTokenManualTopUp(t)
	require.NoError(t, model.DB.Callback().Create().Before("gorm:create").Register("manual-fixture-failure", func(tx *gorm.DB) {
		if tx.Statement.Table == "top_ups" {
			tx.AddError(errors.New("fixture database transport failure"))
		}
	}))
	t.Cleanup(func() { require.NoError(t, model.DB.Callback().Create().Remove("manual-fixture-failure")) })
	requestTokenManual(t, engine, "POST", "/orders", `{"amount":10,"payment_method":"manual_wechat"}`, 503)
	var count int64
	require.NoError(t, model.DB.Model(&model.TopUp{}).Count(&count).Error)
	assert.Zero(t, count)
}
