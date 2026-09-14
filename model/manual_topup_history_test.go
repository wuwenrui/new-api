package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetUserManualTopUpHistoryFiltersBeforePagination(t *testing.T) {
	now := common.GetTimestamp()
	owner := &User{Username: "manual-history-owner", AffCode: "manual-history-owner"}
	require.NoError(t, DB.Create(owner).Error)
	rows := []TopUp{
		{TradeNo: "hist-pending", UserId: owner.Id, PaymentProvider: PaymentProviderManualTopUp, PaymentMethod: PaymentMethodManualWechat, Status: common.TopUpStatusPending, Money: 10, CreateTime: now - 60},
		{TradeNo: "hist-success", UserId: owner.Id, PaymentProvider: PaymentProviderManualTopUp, PaymentMethod: PaymentMethodManualAlipay, Status: common.TopUpStatusSuccess, Money: 20, CreateTime: now - 50, CompleteTime: now - 40},
		{TradeNo: "hist-failed", UserId: owner.Id, PaymentProvider: PaymentProviderManualTopUp, Status: common.TopUpStatusFailed, CreateTime: now - 30},
		{TradeNo: "hist-other-owner", UserId: owner.Id + 1, PaymentProvider: PaymentProviderManualTopUp, CreateTime: now - 20},
		{TradeNo: "hist-other-provider", UserId: owner.Id, PaymentProvider: PaymentProviderStripe, CreateTime: now - 20},
		{TradeNo: "hist-subscription", UserId: owner.Id, PaymentProvider: PaymentProviderManualSubscription, CreateTime: now - 20},
		{TradeNo: "hist-too-old", UserId: owner.Id, PaymentProvider: PaymentProviderManualTopUp, CreateTime: now - 31*24*60*60},
		{TradeNo: "hist-future", UserId: owner.Id, PaymentProvider: PaymentProviderManualTopUp, CreateTime: now + 24*60*60},
	}
	require.NoError(t, DB.Create(&rows).Error)
	items, total, err := GetUserManualTopUpHistory(owner.Id, 2, 1)
	require.NoError(t, err)
	assert.Equal(t, int64(4), total)
	require.Len(t, items, 1)
	assert.Equal(t, &ManualTopUpHistoryItem{TradeNo: "hist-success", Money: 20, PaymentMethod: PaymentMethodManualAlipay, Status: common.TopUpStatusSuccess, CreateTime: now - 50, CompleteTime: now - 40}, items[0])
	encoded, err := common.Marshal(items[0])
	require.NoError(t, err)
	var payload map[string]interface{}
	require.NoError(t, common.Unmarshal(encoded, &payload))
	assert.Len(t, payload, 6)
	assert.NotContains(t, payload, "user_id")
	assert.NotContains(t, payload, "amount")
	assert.NotContains(t, payload, "payment_provider")
	items, total, err = GetUserManualTopUpHistory(owner.Id, 0, 10)
	require.NoError(t, err)
	assert.Equal(t, int64(4), total)
	require.Len(t, items, 4)
	// Match the model site's shared lower-bound-only history window.
	assert.Equal(t, "hist-future", items[0].TradeNo)
	assert.Equal(t, "hist-failed", items[1].TradeNo)
	assert.Equal(t, "hist-pending", items[3].TradeNo)
	items, total, err = GetUserManualTopUpHistory(owner.Id, 10, 10)
	require.NoError(t, err)
	assert.Equal(t, int64(4), total)
	assert.Empty(t, items)
	encoded, err = common.Marshal(items)
	require.NoError(t, err)
	assert.Equal(t, "[]", string(encoded))
}

func TestGetUserManualTopUpHistoryRejectsUnboundedInputs(t *testing.T) {
	for _, args := range [][3]int{{0, 0, 10}, {1, -1, 10}, {1, 0, 0}, {1, 0, -1}} {
		items, total, err := GetUserManualTopUpHistory(args[0], args[1], args[2])
		require.Error(t, err)
		assert.Empty(t, items)
		assert.Zero(t, total)
	}
}
