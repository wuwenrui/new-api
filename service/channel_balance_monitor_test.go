package service

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/model"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupChannelBalanceMonitorTestDB(t *testing.T) {
	t.Helper()
	originalDB := model.DB

	dbPath := filepath.Join(t.TempDir(), "channel-balance-monitor.db")
	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.Channel{}))
	model.DB = db

	t.Cleanup(func() {
		model.DB = originalDB
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
	})
}

func seedBalanceChannel(t *testing.T, id int, name string, balance float64, balanceUpdatedTime int64) {
	t.Helper()
	autoBan := 1
	priority := int64(0)
	weight := uint(0)
	require.NoError(t, model.DB.Create(&model.Channel{
		Id:                 id,
		Type:               14,
		Key:                "redacted",
		Status:             1,
		Name:               name,
		Weight:             &weight,
		Models:             "m-x",
		Group:              "default",
		Priority:           &priority,
		AutoBan:            &autoBan,
		Balance:            balance,
		BalanceUpdatedTime: balanceUpdatedTime,
		CreatedTime:        100,
	}).Error)
}

func lowBalanceTestReport(rows ...ChannelBusinessRow) ChannelBusinessReport {
	return ChannelBusinessReport{
		LowBalanceThreshold: 10.0,
		Rows:                rows,
	}
}

func lowBalanceNotifiedFlag(t *testing.T, channelID int) bool {
	t.Helper()
	var channel model.Channel
	require.NoError(t, model.DB.First(&channel, channelID).Error)
	return channel.GetOtherSettings().LowBalanceNotified
}

func setChannelBalance(t *testing.T, channelID int, balance float64) {
	t.Helper()
	require.NoError(t, model.DB.Model(&model.Channel{}).
		Where("id = ?", channelID).
		Update("balance", balance).Error)
}

// 跨阈值状态机：首次跌破推一次 → 持续低于不重复 → 回升清除标记 → 再跌破再推；
// 余额未知（balance_updated_time=0）的渠道不告警。
func TestProcessChannelLowBalanceAlertsCrossingStateMachine(t *testing.T) {
	setupChannelBalanceMonitorTestDB(t)
	seedBalanceChannel(t, 1, "low-channel", 5, 100)
	seedBalanceChannel(t, 2, "healthy-channel", 50, 100)
	seedBalanceChannel(t, 3, "unknown-balance-channel", 0, 0)

	report := lowBalanceTestReport(
		ChannelBusinessRow{ChannelID: 1, ChannelName: "low-channel", Balance: 5, LowBalance: true},
		ChannelBusinessRow{ChannelID: 2, ChannelName: "healthy-channel", Balance: 50, LowBalance: false},
		ChannelBusinessRow{ChannelID: 3, ChannelName: "unknown-balance-channel", Balance: 0, LowBalance: true},
	)

	// 首次跌破：只有 channel 1 告警（channel 3 余额未知被跳过）
	alerts, err := ProcessChannelLowBalanceAlerts(report)
	require.NoError(t, err)
	require.Len(t, alerts, 1)
	assert.Equal(t, 1, alerts[0].ChannelID)
	assert.Equal(t, "low-channel", alerts[0].ChannelName)
	assert.Equal(t, 5.0, alerts[0].Balance)
	assert.Equal(t, 10.0, alerts[0].Threshold)
	assert.True(t, lowBalanceNotifiedFlag(t, 1))
	assert.False(t, lowBalanceNotifiedFlag(t, 2))
	assert.False(t, lowBalanceNotifiedFlag(t, 3))

	// 持续低于阈值：不重复告警
	alerts, err = ProcessChannelLowBalanceAlerts(report)
	require.NoError(t, err)
	assert.Empty(t, alerts)

	// 余额回升到阈值以上：清除标记，不告警
	setChannelBalance(t, 1, 50)
	recovered := lowBalanceTestReport(
		ChannelBusinessRow{ChannelID: 1, ChannelName: "low-channel", Balance: 50, LowBalance: false},
		ChannelBusinessRow{ChannelID: 2, ChannelName: "healthy-channel", Balance: 50, LowBalance: false},
	)
	alerts, err = ProcessChannelLowBalanceAlerts(recovered)
	require.NoError(t, err)
	assert.Empty(t, alerts)
	assert.False(t, lowBalanceNotifiedFlag(t, 1))

	// 再次跌破：重新告警一次
	setChannelBalance(t, 1, 3)
	redropped := lowBalanceTestReport(
		ChannelBusinessRow{ChannelID: 1, ChannelName: "low-channel", Balance: 3, LowBalance: true},
		ChannelBusinessRow{ChannelID: 2, ChannelName: "healthy-channel", Balance: 50, LowBalance: false},
	)
	alerts, err = ProcessChannelLowBalanceAlerts(redropped)
	require.NoError(t, err)
	require.Len(t, alerts, 1)
	assert.Equal(t, 1, alerts[0].ChannelID)
	assert.Equal(t, 3.0, alerts[0].Balance)
	assert.True(t, lowBalanceNotifiedFlag(t, 1))

	// 再次持续低于：仍不重复
	alerts, err = ProcessChannelLowBalanceAlerts(redropped)
	require.NoError(t, err)
	assert.Empty(t, alerts)
}

func TestBuildChannelLowBalanceNotification(t *testing.T) {
	subject, content := BuildChannelLowBalanceNotification([]ChannelLowBalanceAlert{
		{ChannelID: 1, ChannelName: "packy-主站", Balance: 4.25, Threshold: 10},
		{ChannelID: 2, ChannelName: "packy-备站", Balance: 0.5, Threshold: 10},
	})
	assert.Equal(t, "渠道余额不足告警", subject)
	assert.True(t, strings.Contains(content, "2 个渠道"))
	assert.True(t, strings.Contains(content, "渠道「packy-主站」当前余额 $4.25，低于阈值 $10.00"))
	assert.True(t, strings.Contains(content, "渠道「packy-备站」当前余额 $0.50，低于阈值 $10.00"))
}
