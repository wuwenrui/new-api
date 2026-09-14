package controller

import (
	"errors"
	"fmt"
	"math"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/shopspring/decimal"
)

// manualTopUpUnits validates settings before any decimal constructor or conversion.
func manualTopUpUnits() (minimum, step int64, err error) {
	unit := common.QuotaPerUnit
	if math.IsNaN(unit) || math.IsInf(unit, 0) || unit <= 0 || unit > common.MaxWalletQuota || math.IsNaN(operation_setting.Price) || math.IsInf(operation_setting.Price, 0) || operation_setting.Price <= 0 {
		return 0, 0, errors.New("人工充值配置无效")
	}
	step = 1
	switch operation_setting.GetQuotaDisplayType() {
	case operation_setting.QuotaDisplayTypeUSD, operation_setting.QuotaDisplayTypeCNY, operation_setting.QuotaDisplayTypeCustom:
	case operation_setting.QuotaDisplayTypeTokens:
		if math.Trunc(unit) != unit {
			return 0, 0, errors.New("人工充值单位不可表示")
		}
		step = int64(unit) // bounded positive integral configuration, not quota rounding
	default:
		return 0, 0, errors.New("不支持的充值展示单位")
	}
	min := operation_setting.ManualTopUpMinTopUp
	if min <= 0 {
		min = 1
	} // same website default
	value, conversionErr := common.WalletQuotaFromDecimalStrict(decimal.NewFromInt(int64(min)).Mul(decimal.NewFromInt(step)))
	if conversionErr != nil || value <= 0 {
		return 0, 0, errors.New("人工充值最低数量无效")
	}
	minimum = int64(value)
	if minimum > getMaxTopUpAmount() {
		return 0, 0, errors.New("人工充值最低数量超出范围")
	}
	return minimum, step, nil
}

type manualTopUpQuote struct {
	Amount          int64   `json:"amount"`
	PaymentMethod   string  `json:"payment_method"`
	Money           float64 `json:"money"`
	PaymentCurrency string  `json:"payment_currency"`
	ExpectedQuota   int     `json:"expected_quota"`
	method          manualTopUpMethod
}

// quoteManualTopUp is shared by the website, facade preview and order creation.
// Request amount is recharge quantity, never a client-selected CNY price.
func quoteManualTopUp(userID int, req ManualTopUpRequest) (*manualTopUpQuote, error) {
	minimum, step, err := manualTopUpUnits()
	if err != nil {
		return nil, err
	}
	method, ok := getManualTopUpMethod(req.PaymentMethod)
	if !ok {
		return nil, errors.New("支付方式不存在或未启用")
	}
	if req.Amount <= 0 || req.Amount < minimum || req.Amount%step != 0 {
		return nil, fmt.Errorf("充值数量必须不小于 %d 且为 %d 的整数倍", minimum, step)
	}
	quota, err := validateTopUpQuota(req.Amount)
	if err != nil {
		return nil, err
	}
	if err = model.ValidateTopUpQuotaCapacity(userID, quota); err != nil {
		return nil, err
	}
	group, err := model.GetUserGroup(userID, false)
	if err != nil {
		return nil, errors.New("获取用户分组失败")
	}
	ratio := common.GetTopupGroupRatio(group)
	if math.IsNaN(ratio) || math.IsInf(ratio, 0) || ratio < 0 {
		return nil, errors.New("充值分组配置无效")
	}
	if discount, exists := operation_setting.GetPaymentSetting().AmountDiscount[int(req.Amount)]; exists {
		if math.IsNaN(discount) || math.IsInf(discount, 0) {
			return nil, errors.New("充值折扣配置无效")
		}
	}
	money := getPayMoney(req.Amount, group)
	if math.IsNaN(money) || math.IsInf(money, 0) || money < 0.01 || money > common.MaxWalletQuota {
		return nil, errors.New("充值金额无效")
	}
	return &manualTopUpQuote{Amount: req.Amount, PaymentMethod: method.Type, Money: money, PaymentCurrency: "CNY", ExpectedQuota: quota, method: method}, nil
}
