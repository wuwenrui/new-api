package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/require"
)

func TestConfirmManualTopUpStatusMarksSuccessWithoutCrediting(t *testing.T) {
	u1 := createManualTopUpForTest(t, "CONFIRM_A", 50, 50)
	u2 := createManualTopUpForTest(t, "CONFIRM_B", 200, 200)

	count, err := ConfirmManualTopUpStatus([]string{"CONFIRM_A", "CONFIRM_B"}, false)
	require.NoError(t, err)
	require.Equal(t, int64(2), count)

	// 状态置为成功、完成时间写入
	require.Equal(t, common.TopUpStatusSuccess, reloadTopUp(t, "CONFIRM_A").Status)
	require.Equal(t, common.TopUpStatusSuccess, reloadTopUp(t, "CONFIRM_B").Status)
	require.Greater(t, reloadTopUp(t, "CONFIRM_A").CompleteTime, int64(0))

	// 关键：仅改状态，绝不给用户加额度
	require.Equal(t, 0, reloadUserQuota(t, u1.Id))
	require.Equal(t, 0, reloadUserQuota(t, u2.Id))
}

func TestConfirmManualTopUpStatusIgnoresNonPendingAndNonManual(t *testing.T) {
	// 已成功的人工单：再次确认不应重复计数
	u := createManualTopUpForTest(t, "CONFIRM_DONE", 10, 10)
	_, err := ConfirmManualTopUpStatus([]string{"CONFIRM_DONE"}, false)
	require.NoError(t, err)
	count, err := ConfirmManualTopUpStatus([]string{"CONFIRM_DONE"}, false)
	require.NoError(t, err)
	require.Equal(t, int64(0), count)
	require.Equal(t, 0, reloadUserQuota(t, u.Id))

	// 非人工充值的 pending 订单：禁止被批量确认动到
	other := &User{Username: "u_epay_confirm", AffCode: "aff_epay_confirm"}
	require.NoError(t, DB.Create(other).Error)
	epay := &TopUp{
		UserId:          other.Id,
		Amount:          5,
		Money:           5,
		TradeNo:         "CONFIRM_EPAY",
		PaymentMethod:   "alipay",
		PaymentProvider: PaymentProviderEpay,
		CreateTime:      common.GetTimestamp(),
		Status:          common.TopUpStatusPending,
	}
	require.NoError(t, DB.Create(epay).Error)

	count, err = ConfirmManualTopUpStatus([]string{"CONFIRM_EPAY"}, false)
	require.NoError(t, err)
	require.Equal(t, int64(0), count)
	require.Equal(t, common.TopUpStatusPending, reloadTopUp(t, "CONFIRM_EPAY").Status)
}

func TestConfirmManualTopUpStatusRequiresInput(t *testing.T) {
	_, err := ConfirmManualTopUpStatus(nil, false)
	require.Error(t, err)
}

func TestCancelManualTopUpStatusMarksFailedWithoutCrediting(t *testing.T) {
	u := createManualTopUpForTest(t, "CANCEL_A", 50, 50)

	count, err := CancelManualTopUpStatus([]string{"CANCEL_A"}, false)
	require.NoError(t, err)
	require.Equal(t, int64(1), count)

	tp := reloadTopUp(t, "CANCEL_A")
	require.Equal(t, common.TopUpStatusFailed, tp.Status)
	require.Greater(t, tp.CompleteTime, int64(0))
	require.Equal(t, 0, reloadUserQuota(t, u.Id))
}

func TestCancelManualTopUpStatusIgnoresNonPendingAndNonManual(t *testing.T) {
	u := createManualTopUpForTest(t, "CANCEL_DONE", 10, 10)
	_, err := ConfirmManualTopUpStatus([]string{"CANCEL_DONE"}, false)
	require.NoError(t, err)

	count, err := CancelManualTopUpStatus([]string{"CANCEL_DONE"}, false)
	require.NoError(t, err)
	require.Equal(t, int64(0), count)
	require.Equal(t, common.TopUpStatusSuccess, reloadTopUp(t, "CANCEL_DONE").Status)
	require.Equal(t, 0, reloadUserQuota(t, u.Id))

	other := &User{Username: "u_epay_cancel", AffCode: "aff_epay_cancel"}
	require.NoError(t, DB.Create(other).Error)
	require.NoError(t, DB.Create(&TopUp{
		UserId:          other.Id,
		Amount:          5,
		Money:           5,
		TradeNo:         "CANCEL_EPAY",
		PaymentMethod:   "alipay",
		PaymentProvider: PaymentProviderEpay,
		CreateTime:      common.GetTimestamp(),
		Status:          common.TopUpStatusPending,
	}).Error)

	count, err = CancelManualTopUpStatus([]string{"CANCEL_EPAY"}, false)
	require.NoError(t, err)
	require.Equal(t, int64(0), count)
	require.Equal(t, common.TopUpStatusPending, reloadTopUp(t, "CANCEL_EPAY").Status)
}

func TestCancelManualTopUpStatusRequiresInput(t *testing.T) {
	_, err := CancelManualTopUpStatus(nil, false)
	require.Error(t, err)
}
