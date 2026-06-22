package controller

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

type financeReportAPIResponse struct {
	Success bool                  `json:"success"`
	Message string                `json:"message"`
	Data    service.FinanceReport `json:"data"`
}

func setupFinanceReportControllerTestDB(t *testing.T) {
	t.Helper()
	originalDB := model.DB
	originalLogDB := model.LOG_DB
	originalQuotaPerUnit := common.QuotaPerUnit

	gin.SetMode(gin.TestMode)
	dbPath := filepath.Join(t.TempDir(), "finance-report-controller.db")
	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(
		&model.Log{},
		&model.TopUp{},
		&model.SubscriptionOrder{},
		&model.User{},
	))
	model.DB = db
	model.LOG_DB = db
	common.QuotaPerUnit = 500000

	t.Cleanup(func() {
		model.DB = originalDB
		model.LOG_DB = originalLogDB
		common.QuotaPerUnit = originalQuotaPerUnit
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
	})
}

func TestGetFinanceReportReturnsFilteredReport(t *testing.T) {
	setupFinanceReportControllerTestDB(t)

	require.NoError(t, model.LOG_DB.Create(&model.Log{
		Username:  "wyh",
		CreatedAt: 1100,
		Type:      model.LogTypeConsume,
		ModelName: "deepseek-v4-flash",
		Quota:     1000000,
		Group:     "default",
		Other:     `{"group_ratio":2}`,
	}).Error)
	require.NoError(t, model.LOG_DB.Create(&model.Log{
		Username:  "wyh",
		CreatedAt: 1100,
		Type:      model.LogTypeConsume,
		ModelName: "qwen3-vl-flash",
		Quota:     1000000,
		Group:     "default",
		Other:     `{"group_ratio":2}`,
	}).Error)

	req := httptest.NewRequest(http.MethodGet, "/api/finance/report?start_timestamp=1000&end_timestamp=2000&model_name=deepseek-v4-flash", nil)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = req

	GetFinanceReport(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	var payload financeReportAPIResponse
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &payload))
	require.True(t, payload.Success)
	require.Equal(t, int64(1), payload.Data.Summary.Requests)
	require.Equal(t, "deepseek-v4-flash", payload.Data.Models[0].ModelName)
	require.Equal(t, int64(1000), payload.Data.StartTimestamp)
	require.Equal(t, int64(2000), payload.Data.EndTimestamp)
}
