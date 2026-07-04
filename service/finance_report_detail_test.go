package service

import (
	"testing"

	"github.com/QuantumNous/new-api/model"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func seedFinanceOrders(t *testing.T) {
	t.Helper()
	require.NoError(t, model.DB.Create(&model.User{Username: "wyh", AffCode: "a1", Quota: 1000000}).Error)
	require.NoError(t, model.DB.Create(&model.User{Username: "wuwenrui", AffCode: "a2", Quota: 99}).Error)
	var wyh, self model.User
	require.NoError(t, model.DB.Where("username = ?", "wyh").First(&wyh).Error)
	require.NoError(t, model.DB.Where("username = ?", "wuwenrui").First(&self).Error)

	require.NoError(t, model.DB.Create(&model.TopUp{UserId: wyh.Id, Money: 100, TradeNo: "t1", Status: "success", CreateTime: 900, CompleteTime: 1000}).Error)
	require.NoError(t, model.DB.Create(&model.TopUp{UserId: wyh.Id, Money: 50, TradeNo: "t2", Status: "pending", CreateTime: 1100}).Error)
	require.NoError(t, model.DB.Create(&model.TopUp{UserId: self.Id, Money: 999, TradeNo: "t3", Status: "success", CreateTime: 900, CompleteTime: 1000}).Error)
	require.NoError(t, model.DB.Create(&model.SubscriptionOrder{UserId: wyh.Id, PlanId: 1, Money: 199, TradeNo: "s1", Status: "success", CreateTime: 900, CompleteTime: 2000}).Error)
}

func TestListFinanceOrdersDefaultsToSuccessAndExcludesSelf(t *testing.T) {
	setupFinanceReportTestDB(t)
	seedFinanceOrders(t)

	rows, total, err := ListFinanceOrders(FinanceOrderListParams{Table: "top_ups", Offset: 0, Limit: 10})
	require.NoError(t, err)
	assert.Equal(t, int64(1), total)
	require.Len(t, rows, 1)
	assert.Equal(t, "wyh", rows[0].Username)
	assert.Equal(t, 100.0, rows[0].Money)
}

func TestListFinanceOrdersStatusAllAndTimeFilter(t *testing.T) {
	setupFinanceReportTestDB(t)
	seedFinanceOrders(t)

	rows, total, err := ListFinanceOrders(FinanceOrderListParams{
		Table: "top_ups", Status: "all", StartTimestamp: 1050, Offset: 0, Limit: 10,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), total)
	assert.Equal(t, "pending", rows[0].Status)

	_, total, err = ListFinanceOrders(FinanceOrderListParams{
		Table: "top_ups", StartTimestamp: 1500, Offset: 0, Limit: 10,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(0), total)
}

func TestListFinanceOrdersSubscriptionTableAndUsernameFilter(t *testing.T) {
	setupFinanceReportTestDB(t)
	seedFinanceOrders(t)

	rows, total, err := ListFinanceOrders(FinanceOrderListParams{
		Table: "subscription_orders", Username: "wyh", Offset: 0, Limit: 10,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), total)
	assert.Equal(t, 199.0, rows[0].Money)
	assert.Equal(t, 1, rows[0].PlanId)

	_, _, err = ListFinanceOrders(FinanceOrderListParams{Table: "users"})
	assert.Error(t, err)
}

func TestBuildFinanceBalancesComputesGiftedEstimate(t *testing.T) {
	setupFinanceReportTestDB(t)
	seedFinanceOrders(t)
	require.NoError(t, model.DB.Create(&model.Log{Username: "wyh", Type: model.LogTypeConsume, Quota: 500000, CreatedAt: 1000}).Error)
	require.NoError(t, model.DB.Create(&model.Log{Username: "wuwenrui", Type: model.LogTypeConsume, Quota: 500000, CreatedAt: 1000}).Error)

	rows, err := BuildFinanceBalances()
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "wyh", rows[0].Username)
	requireFloatNear(t, 2.0, rows[0].Balance)
	requireFloatNear(t, 100.0, rows[0].TotalTopUp)
	requireFloatNear(t, 1.0, rows[0].TotalConsumed)
	requireFloatNear(t, -97.0, rows[0].GiftedEstimate)
}

func TestBuildFinanceReportUserRowsIncludeSnapshots(t *testing.T) {
	setupFinanceReportTestDB(t)
	seedFinanceOrders(t)
	require.NoError(t, model.DB.Create(&model.Log{Username: "wyh", Type: model.LogTypeConsume, Quota: 250000, CreatedAt: 1000}).Error)

	report, err := BuildFinanceReport(FinanceReportParams{})
	require.NoError(t, err)
	require.Len(t, report.Users, 1)
	requireFloatNear(t, 2.0, report.Users[0].Balance)
	requireFloatNear(t, 100.0, report.Users[0].TotalTopUp)
}
