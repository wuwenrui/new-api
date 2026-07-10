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

type manualTopUpOrdersAPIResponse struct {
	Success bool `json:"success"`
	Data    struct {
		Items []struct {
			TradeNo       string  `json:"trade_no"`
			UserId        int     `json:"user_id"`
			Username      string  `json:"username"`
			Email         string  `json:"email"`
			Amount        int64   `json:"amount"`
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

func seedManualTopUpOrderForList(t *testing.T, username string, tradeNo string, provider string, status string, amount int64, money float64, createdAt int64) *model.User {
	t.Helper()
	user := &model.User{Username: username, Email: username + "@example.com", AffCode: "aff_" + tradeNo}
	require.NoError(t, model.DB.Create(user).Error)
	require.NoError(t, model.DB.Create(&model.TopUp{
		UserId:          user.Id,
		Amount:          amount,
		Money:           money,
		TradeNo:         tradeNo,
		PaymentMethod:   model.PaymentMethodManualWechat,
		PaymentProvider: provider,
		CreateTime:      createdAt,
		CompleteTime:    createdAt + 100,
		Status:          status,
	}).Error)
	return user
}

func callManualTopUpOrders(t *testing.T, target string) manualTopUpOrdersAPIResponse {
	t.Helper()
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, target, nil)

	GetManualTopUpOrders(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	var response manualTopUpOrdersAPIResponse
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	require.True(t, response.Success)
	return response
}

func TestGetManualTopUpOrdersFiltersSearchesAndSummarizes(t *testing.T) {
	setupTopUpAdminCompleteTestDB(t)
	seedManualTopUpOrderForList(t, "alice", "MANUAL-PENDING", model.PaymentProviderManualTopUp, common.TopUpStatusPending, 50, 50, 1000)
	seedManualTopUpOrderForList(t, "bob", "MANUAL-SUCCESS", model.PaymentProviderManualTopUp, common.TopUpStatusSuccess, 80, 88, 1200)
	seedManualTopUpOrderForList(t, "carol", "ONLINE-PENDING", model.PaymentProviderEpay, common.TopUpStatusPending, 30, 30, 1300)

	response := callManualTopUpOrders(t, "/api/user/topup/manual?p=1&page_size=20&keyword=bob&status=success")

	require.Equal(t, 1, response.Data.Total)
	require.Len(t, response.Data.Items, 1)
	require.Equal(t, "MANUAL-SUCCESS", response.Data.Items[0].TradeNo)
	require.Equal(t, "bob", response.Data.Items[0].Username)
	require.Equal(t, common.TopUpStatusSuccess, response.Data.Items[0].Status)
	require.Equal(t, int64(1), response.Data.Summary.TotalCount)
	require.Equal(t, int64(0), response.Data.Summary.PendingCount)
	require.Equal(t, int64(1), response.Data.Summary.SuccessCount)
	require.InDelta(t, 88, response.Data.Summary.TotalMoney, 0.000001)
	require.InDelta(t, 88, response.Data.Summary.SuccessMoney, 0.000001)
	require.Len(t, response.Data.Summary.ByStatus, 1)
	require.Equal(t, common.TopUpStatusSuccess, response.Data.Summary.ByStatus[0].Status)
	require.Len(t, response.Data.Summary.ByMethod, 1)
	require.Equal(t, model.PaymentMethodManualWechat, response.Data.Summary.ByMethod[0].PaymentMethod)
}

func TestGetManualTopUpOrdersSummaryExcludesFailedFromTotals(t *testing.T) {
	setupTopUpAdminCompleteTestDB(t)
	seedManualTopUpOrderForList(t, "alice", "MANUAL-PENDING-TOTAL", model.PaymentProviderManualTopUp, common.TopUpStatusPending, 50, 50, 1000)
	seedManualTopUpOrderForList(t, "bob", "MANUAL-SUCCESS-TOTAL", model.PaymentProviderManualTopUp, common.TopUpStatusSuccess, 80, 80, 1200)
	seedManualTopUpOrderForList(t, "carol", "MANUAL-FAILED-TOTAL", model.PaymentProviderManualTopUp, common.TopUpStatusFailed, 90, 90, 1300)

	response := callManualTopUpOrders(t, "/api/user/topup/manual?p=1&page_size=20")

	require.Equal(t, 3, response.Data.Total)
	require.Equal(t, int64(2), response.Data.Summary.TotalCount)
	require.InDelta(t, 130, response.Data.Summary.TotalMoney, 0.000001)
	require.InDelta(t, 80, response.Data.Summary.SuccessMoney, 0.000001)
	require.Len(t, response.Data.Summary.ByStatus, 3)
	require.Len(t, response.Data.Summary.ByMethod, 1)
	require.Equal(t, int64(2), response.Data.Summary.ByMethod[0].Count)
	require.InDelta(t, 130, response.Data.Summary.ByMethod[0].Money, 0.000001)
}
