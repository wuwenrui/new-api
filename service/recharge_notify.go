package service

import (
	"fmt"
	"net/url"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/setting/operation_setting"
)

// NotifyRechargePending 通过 Bark 给管理员推送一条带深链的人工充值待确认通知。
// 返回 sent 标识是否已成功发送（用于调用方决定是否回退到旧通知）。
// 未启用、未配置 Bark URL，或发送失败时返回 false，调用方应回退到原有通知方式，
// 避免管理员漏收充值待确认通知。
func NotifyRechargePending(userID int, tradeNo, paymentName string, displayAmount int64, payMoney float64) (sent bool) {
	if !operation_setting.RechargeNotifyEnabled || operation_setting.RechargeNotifyBarkUrl == "" {
		return false
	}

	barkURL := operation_setting.RechargeNotifyBarkUrl

	linkBase := operation_setting.RechargeNotifyLinkBase
	if linkBase == "" {
		linkBase = GetCallbackAddress()
	}
	deepLink := linkBase + "/recharge-review?trade_no=" + url.QueryEscape(tradeNo)

	title := "新的人工充值待确认"
	content := fmt.Sprintf(
		"用户ID: %d 收款方式: %s 申请额度: %d 应收金额: ¥%.2f",
		userID,
		paymentName,
		displayAmount,
		payMoney,
	)
	notify := dto.NewNotify(dto.NotifyTypeManualTopUp, title, content, nil)

	if err := sendBarkRequest(barkURL, notify, deepLink); err != nil {
		common.SysLog(fmt.Sprintf("failed to send recharge pending bark notify (trade_no=%s): %s", tradeNo, err.Error()))
		return false
	}
	return true
}

// NotifySubscriptionPending 通过 Bark 给管理员推送一条带深链的人工订阅待确认通知。
func NotifySubscriptionPending(userID int, tradeNo, planTitle, paymentName string, payMoney float64) (sent bool) {
	if !operation_setting.RechargeNotifyEnabled || operation_setting.RechargeNotifyBarkUrl == "" {
		return false
	}

	barkURL := operation_setting.RechargeNotifyBarkUrl

	linkBase := operation_setting.RechargeNotifyLinkBase
	if linkBase == "" {
		linkBase = GetCallbackAddress()
	}
	deepLink := linkBase + "/subscription-review?trade_no=" + url.QueryEscape(tradeNo)

	title := "新的人工订阅待确认"
	content := fmt.Sprintf(
		"用户ID: %d 套餐: %s 收款方式: %s 应收金额: ¥%.2f",
		userID,
		planTitle,
		paymentName,
		payMoney,
	)
	notify := dto.NewNotify(dto.NotifyTypeManualSubscription, title, content, nil)

	if err := sendBarkRequest(barkURL, notify, deepLink); err != nil {
		common.SysLog(fmt.Sprintf("failed to send subscription pending bark notify (trade_no=%s): %s", tradeNo, err.Error()))
		return false
	}
	return true
}
