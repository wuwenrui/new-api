package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/require"
)

func seedTopUp(t *testing.T, tradeNo, provider, status string) {
	t.Helper()
	require.NoError(t, DB.Create(&TopUp{
		UserId:          1,
		Amount:          10,
		Money:           10,
		TradeNo:         tradeNo,
		PaymentMethod:   PaymentMethodManualWechat,
		PaymentProvider: provider,
		CreateTime:      common.GetTimestamp(),
		Status:          status,
	}).Error)
}

func TestGetPendingManualTopUpsOnlyReturnsPendingManual(t *testing.T) {
	// 干净表，避免其它用例污染
	require.NoError(t, DB.Where("1 = 1").Delete(&TopUp{}).Error)

	seedTopUp(t, "PMQpend1", PaymentProviderManualTopUp, common.TopUpStatusPending)
	seedTopUp(t, "PMQpend2", PaymentProviderManualTopUp, common.TopUpStatusPending)
	// 已成功的人工单：排除
	seedTopUp(t, "PMQsuccess", PaymentProviderManualTopUp, common.TopUpStatusSuccess)
	// pending 但非人工单：排除
	seedTopUp(t, "PMQepay", PaymentProviderEpay, common.TopUpStatusPending)

	pageInfo := &common.PageInfo{Page: 1, PageSize: 100}
	topups, total, err := GetPendingManualTopUps(pageInfo)
	require.NoError(t, err)
	require.Equal(t, int64(2), total)
	require.Len(t, topups, 2)
	for _, tp := range topups {
		require.Equal(t, PaymentProviderManualTopUp, tp.PaymentProvider)
		require.Equal(t, common.TopUpStatusPending, tp.Status)
	}
	// 按 id 倒序
	require.Greater(t, topups[0].Id, topups[1].Id)
}

func TestGetPendingManualTopUpsPaginates(t *testing.T) {
	require.NoError(t, DB.Where("1 = 1").Delete(&TopUp{}).Error)

	for _, tn := range []string{"PMQp1", "PMQp2", "PMQp3", "PMQp4", "PMQp5"} {
		seedTopUp(t, tn, PaymentProviderManualTopUp, common.TopUpStatusPending)
	}

	page1, total, err := GetPendingManualTopUps(&common.PageInfo{Page: 1, PageSize: 2})
	require.NoError(t, err)
	require.Equal(t, int64(5), total)
	require.Len(t, page1, 2)

	page3, total, err := GetPendingManualTopUps(&common.PageInfo{Page: 3, PageSize: 2})
	require.NoError(t, err)
	require.Equal(t, int64(5), total)
	require.Len(t, page3, 1)

	// 不同页不重复
	require.NotEqual(t, page1[0].Id, page3[0].Id)
}
