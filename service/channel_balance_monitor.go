package service

import (
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

// ChannelLowBalanceAlert 本次巡检新跌破余额阈值的渠道
type ChannelLowBalanceAlert struct {
	ChannelID   int     `json:"channel_id"`
	ChannelName string  `json:"channel_name"`
	Balance     float64 `json:"balance"`
	Threshold   float64 `json:"threshold"`
}

// ProcessChannelLowBalanceAlerts 依据经营报表的 low_balance 标记做跨阈值告警状态机：
//   - 低余额且 settings.low_balance_notified 未标记 → 打上标记并返回（由调用方通知）；
//   - 持续低于阈值 → 不重复返回（不刷屏）；
//   - 余额回升到阈值以上 → 清除标记，下次跌破会再次告警；
//   - 从未查询过上游余额（balance_updated_time = 0）的渠道余额未知，跳过告警。
//
// 单个渠道标记落库失败只记日志，不影响其他渠道；失败的渠道本次仍返回
// （宁可下轮重复提醒，也不漏报）。
func ProcessChannelLowBalanceAlerts(report ChannelBusinessReport) ([]ChannelLowBalanceAlert, error) {
	rowByChannelID := make(map[int]ChannelBusinessRow, len(report.Rows))
	for _, row := range report.Rows {
		rowByChannelID[row.ChannelID] = row
	}

	var channels []*model.Channel
	if err := model.DB.Model(&model.Channel{}).
		Select("id", "name", "balance", "balance_updated_time", "settings").
		Order("id asc").
		Find(&channels).Error; err != nil {
		return nil, err
	}

	alerts := make([]ChannelLowBalanceAlert, 0)
	for _, channel := range channels {
		if channel == nil {
			continue
		}
		row, inReport := rowByChannelID[channel.Id]
		balanceKnown := channel.BalanceUpdatedTime > 0
		lowBalance := inReport && row.LowBalance && balanceKnown

		settings := channel.GetOtherSettings()
		if lowBalance {
			if settings.LowBalanceNotified {
				continue
			}
			if err := persistChannelLowBalanceNotified(channel, true); err != nil {
				common.SysError(fmt.Sprintf("渠道余额告警标记写入失败 channel_id=%d: %v", channel.Id, err))
			}
			alerts = append(alerts, ChannelLowBalanceAlert{
				ChannelID:   channel.Id,
				ChannelName: channel.Name,
				Balance:     row.Balance,
				Threshold:   report.LowBalanceThreshold,
			})
			continue
		}
		if settings.LowBalanceNotified {
			if err := persistChannelLowBalanceNotified(channel, false); err != nil {
				common.SysError(fmt.Sprintf("渠道余额告警标记清除失败 channel_id=%d: %v", channel.Id, err))
			}
		}
	}
	return alerts, nil
}

// persistChannelLowBalanceNotified 只更新 settings JSON 里的 low_balance_notified 位，
// 基于当前库内 settings 读出-改写-写回，避免覆盖其他字段。
func persistChannelLowBalanceNotified(channel *model.Channel, notified bool) error {
	settings := channel.GetOtherSettings()
	settings.LowBalanceNotified = notified
	channel.SetOtherSettings(settings)
	return model.DB.Model(&model.Channel{}).
		Where("id = ?", channel.Id).
		Update("settings", channel.OtherSettings).Error
}

// BuildChannelLowBalanceNotification 组装低余额告警通知文案（中文硬编码，与 PAC 巡检通知一致）
func BuildChannelLowBalanceNotification(alerts []ChannelLowBalanceAlert) (string, string) {
	var lines []string
	for _, alert := range alerts {
		lines = append(lines, fmt.Sprintf(
			"渠道「%s」当前余额 $%.2f，低于阈值 $%.2f。",
			alert.ChannelName,
			alert.Balance,
			alert.Threshold,
		))
	}
	content := fmt.Sprintf(
		"发现 %d 个渠道上游余额不足，请及时充值：\n%s",
		len(alerts),
		strings.Join(lines, "\n"),
	)
	return "渠道余额不足告警", content
}
