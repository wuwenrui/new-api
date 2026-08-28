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
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// 回归：请求未携带 settings 的局部渠道更新（例如只加模型）不得清空
// other_settings 里的 model_prices（采购价）等已有配置。
func TestUpdateChannelWithoutSettingsPreservesOtherSettings(t *testing.T) {
	gin.SetMode(gin.TestMode)

	originalDB := model.DB
	originalLogDB := model.LOG_DB
	originalRedisEnabled := common.RedisEnabled
	db, err := gorm.Open(
		sqlite.Open(filepath.Join(t.TempDir(), "channel-update.db")),
		&gorm.Config{},
	)
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.Option{}, &model.User{}, &model.Log{}, &model.Channel{}, &model.Ability{}))
	model.DB = db
	model.LOG_DB = db
	common.RedisEnabled = false
	t.Cleanup(func() {
		model.DB = originalDB
		model.LOG_DB = originalLogDB
		common.RedisEnabled = originalRedisEnabled
	})

	originalSettings := `{"pac_upstream_group":"default","model_prices":{"claude-a":{"input":3,"output":15,"cache_read":0.3,"cache_write":3.75,"source":"manual"}}}`
	require.NoError(t, db.Create(&model.Channel{
		Id:            41,
		Name:          "oo-ccmax-claude",
		Type:          1,
		Key:           "sk-test",
		Models:        "claude-a",
		Group:         "default",
		Status:        common.ChannelStatusEnabled,
		OtherSettings: originalSettings,
	}).Error)

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Set("id", 1)
	ctx.Request = httptest.NewRequest(
		http.MethodPut,
		"/api/channel/",
		bytes.NewBufferString(`{"id":41,"models":"claude-a,claude-b"}`),
	)
	ctx.Request.Header.Set("Content-Type", "application/json")

	UpdateChannel(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	require.True(t, response.Success, "update failed: %s", response.Message)

	var reloaded model.Channel
	require.NoError(t, db.First(&reloaded, 41).Error)
	assert.Equal(t, originalSettings, reloaded.OtherSettings)
	settings := reloaded.GetOtherSettings()
	require.Contains(t, settings.ModelPrices, "claude-a")
	assert.Equal(t, 15.0, *settings.ModelPrices["claude-a"].Output)
	assert.Equal(t, "default", settings.PACUpstreamGroup)
}
