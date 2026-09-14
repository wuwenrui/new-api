package controller

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/bytedance/gopkg/util/gopool"
	"github.com/gin-gonic/gin"
)

var errManualTopUpInsert = errors.New("创建订单失败")

func RequestManualTopUp(c *gin.Context) {
	var req ManualTopUpRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "参数错误"})
		return
	}
	data, err := createManualTopUp(c, req)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "success", "data": data})
}

// Both entry points use this single pending-order/notification implementation.
// This creates no credit and has no durable idempotency key.
func createManualTopUp(c *gin.Context, req ManualTopUpRequest) (gin.H, error) {
	id := c.GetInt("id")
	quote, err := quoteManualTopUp(id, req)
	if err != nil {
		return nil, err
	}
	method, payMoney := quote.method, quote.Money
	tradeNo := fmt.Sprintf("MANUSR%dNO%s%d", id, common.GetRandomString(6), time.Now().Unix())
	topUp := &model.TopUp{
		UserId: id, Amount: normalizeTopUpAmountForStorage(req.Amount), Money: payMoney,
		TradeNo: tradeNo, PaymentMethod: method.Type, PaymentProvider: model.PaymentProviderManualTopUp,
		CreateTime: time.Now().Unix(), Status: common.TopUpStatusPending,
	}
	if err := topUp.Insert(); err != nil {
		logger.LogError(c.Request.Context(), fmt.Sprintf("人工充值 创建充值订单失败 user_id=%d trade_no=%s error=%q", id, tradeNo, err.Error()))
		return nil, errManualTopUpInsert
	}
	notification := buildManualTopUpNotification(manualTopUpNotificationInput{
		UserID: id, TradeNo: tradeNo, PaymentName: method.Name, DisplayAmount: req.Amount, PayMoney: payMoney,
	})
	gopool.Go(func() {
		if !service.NotifyRechargePending(id, tradeNo, method.Name, req.Amount, payMoney) {
			service.NotifyRootUser(dto.NotifyTypeManualTopUp, notification.Subject, notification.Content)
		}
	})
	logger.LogInfo(c.Request.Context(), fmt.Sprintf("人工充值 充值订单创建成功 user_id=%d trade_no=%s payment_method=%s amount=%d money=%.2f", id, tradeNo, method.Type, req.Amount, payMoney))
	return gin.H{"trade_no": tradeNo, "amount": topUp.Amount, "display_amount": req.Amount,
		"money": payMoney, "payment_method": method.Type, "payment_name": method.Name,
		"qr_url": method.QRCode, "instructions": operation_setting.ManualTopUpInstructions}, nil
}
