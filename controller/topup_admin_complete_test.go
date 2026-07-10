package controller

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupTopUpAdminCompleteTestDB(t *testing.T) {
	t.Helper()
	originalDB := model.DB
	originalLogDB := model.LOG_DB
	originalQuotaPerUnit := common.QuotaPerUnit
	originalRedisEnabled := common.RedisEnabled
	originalBatchUpdate := common.BatchUpdateEnabled

	common.RedisEnabled = false
	common.BatchUpdateEnabled = false

	gin.SetMode(gin.TestMode)
	dbPath := filepath.Join(t.TempDir(), "topup-admin-complete.db")
	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(
		&model.User{},
		&model.TopUp{},
		&model.Log{},
	))
	model.DB = db
	model.LOG_DB = db
	common.QuotaPerUnit = 500000

	t.Cleanup(func() {
		model.DB = originalDB
		model.LOG_DB = originalLogDB
		common.QuotaPerUnit = originalQuotaPerUnit
		common.RedisEnabled = originalRedisEnabled
		common.BatchUpdateEnabled = originalBatchUpdate
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
	})
}

func seedManualTopUpOrder(t *testing.T, tradeNo string, provider string, amount int64, money float64) *model.User {
	t.Helper()
	user := &model.User{Username: "user_" + tradeNo, AffCode: "aff_" + tradeNo, Quota: 0}
	require.NoError(t, model.DB.Create(user).Error)
	require.NoError(t, model.DB.Create(&model.TopUp{
		UserId:          user.Id,
		Amount:          amount,
		Money:           money,
		TradeNo:         tradeNo,
		PaymentMethod:   model.PaymentMethodManualWechat,
		PaymentProvider: provider,
		CreateTime:      common.GetTimestamp(),
		Status:          common.TopUpStatusPending,
	}).Error)
	return user
}

func callAdminCompleteTopUp(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/user/topup/complete", bytes.NewBufferString(body))
	ctx.Request.Header.Set("Content-Type", "application/json")
	AdminCompleteTopUp(ctx)
	return recorder
}

func callCancelManualTopUpStatus(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/user/topup/cancel-status", bytes.NewBufferString(body))
	ctx.Request.Header.Set("Content-Type", "application/json")
	CancelManualTopUpStatus(ctx)
	return recorder
}

func reloadUserQuota(t *testing.T, userID int) int {
	t.Helper()
	var u model.User
	require.NoError(t, model.DB.Where("id = ?", userID).First(&u).Error)
	return u.Quota
}

func TestAdminCompleteTopUpAmountNilUsesLegacyPath(t *testing.T) {
	setupTopUpAdminCompleteTestDB(t)
	user := seedManualTopUpOrder(t, "ADMC_legacy1", model.PaymentProviderManualTopUp, 50, 50)

	recorder := callAdminCompleteTopUp(t, `{"trade_no":"ADMC_legacy1"}`)
	require.Equal(t, http.StatusOK, recorder.Code)

	// 旧路径：按订单当前 amount(50) 入账
	require.Equal(t, int(50*common.QuotaPerUnit), reloadUserQuota(t, user.Id))
	tp := model.GetTopUpByTradeNo("ADMC_legacy1")
	require.NotNil(t, tp)
	require.Equal(t, common.TopUpStatusSuccess, tp.Status)
	require.Equal(t, int64(50), tp.Amount)
}

func TestAdminCompleteTopUpAmountSetUsesOverridePath(t *testing.T) {
	setupTopUpAdminCompleteTestDB(t)
	user := seedManualTopUpOrder(t, "ADMC_ovr1", model.PaymentProviderManualTopUp, 50, 50)

	recorder := callAdminCompleteTopUp(t, `{"trade_no":"ADMC_ovr1","amount":80}`)
	require.Equal(t, http.StatusOK, recorder.Code)

	// override 路径：按 80 入账，money 等比缩放 50*80/50=80
	require.Equal(t, int(80*common.QuotaPerUnit), reloadUserQuota(t, user.Id))
	tp := model.GetTopUpByTradeNo("ADMC_ovr1")
	require.NotNil(t, tp)
	require.Equal(t, int64(80), tp.Amount)
	require.InDelta(t, 80, tp.Money, 0.000001)
}

func TestAdminCompleteTopUpAmountSetRejectsNonManualOrder(t *testing.T) {
	setupTopUpAdminCompleteTestDB(t)
	user := seedManualTopUpOrder(t, "ADMC_nonmanual1", model.PaymentProviderEpay, 50, 50)

	recorder := callAdminCompleteTopUp(t, `{"trade_no":"ADMC_nonmanual1","amount":80}`)
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Contains(t, recorder.Body.String(), "仅人工充值订单支持调整金额")

	// 未入账
	require.Equal(t, 0, reloadUserQuota(t, user.Id))
	tp := model.GetTopUpByTradeNo("ADMC_nonmanual1")
	require.NotNil(t, tp)
	require.Equal(t, common.TopUpStatusPending, tp.Status)
}

func TestCancelManualTopUpStatusMarksFailedWithoutCrediting(t *testing.T) {
	setupTopUpAdminCompleteTestDB(t)
	user := seedManualTopUpOrder(t, "ADMC_cancel1", model.PaymentProviderManualTopUp, 50, 50)

	recorder := callCancelManualTopUpStatus(t, `{"trade_nos":["ADMC_cancel1"]}`)
	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Success bool `json:"success"`
		Data    struct {
			Count int64 `json:"count"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	require.True(t, response.Success)
	require.Equal(t, int64(1), response.Data.Count)

	require.Equal(t, 0, reloadUserQuota(t, user.Id))
	tp := model.GetTopUpByTradeNo("ADMC_cancel1")
	require.NotNil(t, tp)
	require.Equal(t, common.TopUpStatusFailed, tp.Status)
}
