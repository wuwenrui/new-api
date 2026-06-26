package controller

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type manualSubscriptionOrdersAPIResponse struct {
	Success bool `json:"success"`
	Data    struct {
		Items []struct {
			TradeNo       string  `json:"trade_no"`
			UserId        int     `json:"user_id"`
			Username      string  `json:"username"`
			Email         string  `json:"email"`
			PlanId        int     `json:"plan_id"`
			PlanTitle     string  `json:"plan_title"`
			Money         float64 `json:"money"`
			PaymentMethod string  `json:"payment_method"`
			Status        string  `json:"status"`
		} `json:"items"`
		Total   int `json:"total"`
		Summary struct {
			TotalCount   int64   `json:"total_count"`
			PendingCount int64   `json:"pending_count"`
			SuccessCount int64   `json:"success_count"`
			TotalMoney   float64 `json:"total_money"`
			SuccessMoney float64 `json:"success_money"`
			ByStatus     []struct {
				Status string  `json:"status"`
				Count  int64   `json:"count"`
				Money  float64 `json:"money"`
			} `json:"by_status"`
			ByMethod []struct {
				PaymentMethod string  `json:"payment_method"`
				Count         int64   `json:"count"`
				Money         float64 `json:"money"`
			} `json:"by_method"`
		} `json:"summary"`
	} `json:"data"`
}

func seedManualSubscriptionOrderForList(t *testing.T, username string, planTitle string, tradeNo string, provider string, status string, money float64, createdAt int64) {
	t.Helper()
	user := &model.User{Username: username, Email: username + "@example.com", AffCode: "aff_" + tradeNo}
	require.NoError(t, model.DB.Create(user).Error)
	plan := &model.SubscriptionPlan{
		Title:         planTitle,
		PriceAmount:   money,
		Currency:      "CNY",
		DurationUnit:  model.SubscriptionDurationMonth,
		DurationValue: 1,
		Enabled:       true,
	}
	require.NoError(t, model.DB.Create(plan).Error)
	require.NoError(t, model.DB.Create(&model.SubscriptionOrder{
		UserId:          user.Id,
		PlanId:          plan.Id,
		Money:           money,
		TradeNo:         tradeNo,
		PaymentMethod:   model.PaymentMethodManualWechat,
		PaymentProvider: provider,
		Status:          status,
		CreateTime:      createdAt,
		CompleteTime:    createdAt + 100,
	}).Error)
}

func callManualSubscriptionOrders(t *testing.T, target string) manualSubscriptionOrdersAPIResponse {
	t.Helper()
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, target, nil)

	GetManualSubscriptionOrders(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	var response manualSubscriptionOrdersAPIResponse
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	require.True(t, response.Success)
	return response
}

func TestGetManualSubscriptionOrdersFiltersSearchesAndSummarizes(t *testing.T) {
	setupSubscriptionEntitlementControllerTestDB(t)
	seedManualSubscriptionOrderForList(t, "alice", "微信基础功能", "SUB-PENDING", model.PaymentProviderManualSubscription, common.TopUpStatusPending, 99, 1000)
	seedManualSubscriptionOrderForList(t, "bob", "微信高级功能", "SUB-SUCCESS", model.PaymentProviderManualSubscription, common.TopUpStatusSuccess, 199, 1200)
	seedManualSubscriptionOrderForList(t, "carol", "微信高级功能", "SUB-ONLINE", model.PaymentProviderStripe, common.TopUpStatusPending, 199, 1300)

	response := callManualSubscriptionOrders(t, "/api/subscription/admin/manual/orders?p=1&page_size=20&keyword=高级&status=success")

	require.Equal(t, 1, response.Data.Total)
	require.Len(t, response.Data.Items, 1)
	require.Equal(t, "SUB-SUCCESS", response.Data.Items[0].TradeNo)
	require.Equal(t, "bob", response.Data.Items[0].Username)
	require.Equal(t, "微信高级功能", response.Data.Items[0].PlanTitle)
	require.Equal(t, common.TopUpStatusSuccess, response.Data.Items[0].Status)
	require.Equal(t, int64(1), response.Data.Summary.TotalCount)
	require.Equal(t, int64(0), response.Data.Summary.PendingCount)
	require.Equal(t, int64(1), response.Data.Summary.SuccessCount)
	require.InDelta(t, 199, response.Data.Summary.TotalMoney, 0.000001)
	require.InDelta(t, 199, response.Data.Summary.SuccessMoney, 0.000001)
	require.Len(t, response.Data.Summary.ByStatus, 1)
	require.Equal(t, common.TopUpStatusSuccess, response.Data.Summary.ByStatus[0].Status)
	require.Len(t, response.Data.Summary.ByMethod, 1)
	require.Equal(t, model.PaymentMethodManualWechat, response.Data.Summary.ByMethod[0].PaymentMethod)
}
