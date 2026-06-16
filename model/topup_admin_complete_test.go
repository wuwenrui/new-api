package model

import (
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/require"
)

// createManualTopUpForTest 在共享测试 DB 中插入一条 pending 人工充值订单及其用户。
func createManualTopUpForTest(t *testing.T, tradeNo string, amount int64, money float64) *User {
	t.Helper()
	user := &User{
		Username: "u_" + tradeNo,
		AffCode:  "aff_" + tradeNo,
		Quota:    0,
	}
	require.NoError(t, DB.Create(user).Error)

	topUp := &TopUp{
		UserId:          user.Id,
		Amount:          amount,
		Money:           money,
		TradeNo:         tradeNo,
		PaymentMethod:   PaymentMethodManualWechat,
		PaymentProvider: PaymentProviderManualTopUp,
		CreateTime:      common.GetTimestamp(),
		Status:          common.TopUpStatusPending,
	}
	require.NoError(t, DB.Create(topUp).Error)
	return user
}

func reloadUserQuota(t *testing.T, userID int) int {
	t.Helper()
	var u User
	require.NoError(t, DB.Where("id = ?", userID).First(&u).Error)
	return u.Quota
}

func reloadTopUp(t *testing.T, tradeNo string) *TopUp {
	t.Helper()
	tp := GetTopUpByTradeNo(tradeNo)
	require.NotNil(t, tp)
	return tp
}

func TestAdminCompleteManualTopUpCreditsOverrideAmount(t *testing.T) {
	tradeNo := "ADMOVRcredit1"
	user := createManualTopUpForTest(t, tradeNo, 50, 50)

	require.NoError(t, AdminCompleteManualTopUp(tradeNo, 80, "1.2.3.4"))

	require.Equal(t, int(80*common.QuotaPerUnit), reloadUserQuota(t, user.Id))

	tp := reloadTopUp(t, tradeNo)
	require.Equal(t, common.TopUpStatusSuccess, tp.Status)
	require.Equal(t, int64(80), tp.Amount)
	require.Greater(t, tp.CompleteTime, int64(0))
}

func TestAdminCompleteManualTopUpScalesMoneyProportionally(t *testing.T) {
	// 分组倍率 7.3 的单：amount=1, money=7.3 -> override 到 3 应得 money=21.9
	tradeNo := "ADMOVRscale1"
	user := createManualTopUpForTest(t, tradeNo, 1, 7.3)

	require.NoError(t, AdminCompleteManualTopUp(tradeNo, 3, "1.2.3.4"))

	tp := reloadTopUp(t, tradeNo)
	require.InDelta(t, 21.9, tp.Money, 0.000001)
	require.Equal(t, int(3*common.QuotaPerUnit), reloadUserQuota(t, user.Id))
}

func TestAdminCompleteManualTopUpIsIdempotent(t *testing.T) {
	tradeNo := "ADMOVRidem1"
	user := createManualTopUpForTest(t, tradeNo, 10, 10)

	require.NoError(t, AdminCompleteManualTopUp(tradeNo, 20, "1.2.3.4"))
	quotaAfterFirst := reloadUserQuota(t, user.Id)
	require.Equal(t, int(20*common.QuotaPerUnit), quotaAfterFirst)

	// 重复调用：已 Success，幂等返回，不重复加额
	require.NoError(t, AdminCompleteManualTopUp(tradeNo, 999, "1.2.3.4"))
	require.Equal(t, quotaAfterFirst, reloadUserQuota(t, user.Id))

	tp := reloadTopUp(t, tradeNo)
	require.Equal(t, int64(20), tp.Amount)
}

func TestAdminCompleteManualTopUpRejectsNonManualOrder(t *testing.T) {
	user := &User{Username: "u_nonmanual_ovr", AffCode: "aff_nonmanual_ovr", Quota: 0}
	require.NoError(t, DB.Create(user).Error)
	tradeNo := "ADMOVRnonmanual1"
	require.NoError(t, DB.Create(&TopUp{
		UserId:          user.Id,
		Amount:          10,
		Money:           10,
		TradeNo:         tradeNo,
		PaymentMethod:   PaymentMethodStripe,
		PaymentProvider: PaymentProviderStripe,
		CreateTime:      common.GetTimestamp(),
		Status:          common.TopUpStatusPending,
	}).Error)

	err := AdminCompleteManualTopUp(tradeNo, 20, "1.2.3.4")
	require.Error(t, err)
	require.Contains(t, err.Error(), "仅人工充值订单支持调整金额")

	require.Equal(t, 0, reloadUserQuota(t, user.Id))
}

func TestAdminCompleteManualTopUpRejectsNonPositiveAmount(t *testing.T) {
	tradeNo := "ADMOVRzero1"
	user := createManualTopUpForTest(t, tradeNo, 10, 10)

	require.Error(t, AdminCompleteManualTopUp(tradeNo, 0, "1.2.3.4"))
	require.Error(t, AdminCompleteManualTopUp(tradeNo, -5, "1.2.3.4"))

	require.Equal(t, 0, reloadUserQuota(t, user.Id))
	tp := reloadTopUp(t, tradeNo)
	require.Equal(t, common.TopUpStatusPending, tp.Status)
}

func TestAdminCompleteManualTopUpRejectsNonPendingOrder(t *testing.T) {
	user := &User{Username: "u_completed_ovr", AffCode: "aff_completed_ovr", Quota: 0}
	require.NoError(t, DB.Create(user).Error)
	tradeNo := "ADMOVRfailed1"
	require.NoError(t, DB.Create(&TopUp{
		UserId:          user.Id,
		Amount:          10,
		Money:           10,
		TradeNo:         tradeNo,
		PaymentMethod:   PaymentMethodManualWechat,
		PaymentProvider: PaymentProviderManualTopUp,
		CreateTime:      common.GetTimestamp(),
		Status:          "failed",
	}).Error)

	err := AdminCompleteManualTopUp(tradeNo, 20, "1.2.3.4")
	require.Error(t, err)
	require.Contains(t, err.Error(), "订单状态不是待支付")
	require.Equal(t, 0, reloadUserQuota(t, user.Id))
}

func TestAdminCompleteManualTopUpConcurrentSingleCredit(t *testing.T) {
	tradeNo := "ADMOVRconc1"
	user := createManualTopUpForTest(t, tradeNo, 10, 10)

	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = AdminCompleteManualTopUp(tradeNo, 30, "1.2.3.4")
		}()
	}
	wg.Wait()

	// 行锁 + 幂等：无论并发多少次，只入账一次
	require.Equal(t, int(30*common.QuotaPerUnit), reloadUserQuota(t, user.Id))
	tp := reloadTopUp(t, tradeNo)
	require.Equal(t, common.TopUpStatusSuccess, tp.Status)
	require.Equal(t, int64(30), tp.Amount)
}
