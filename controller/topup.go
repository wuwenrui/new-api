package controller

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/bytedance/gopkg/util/gopool"
	"github.com/gin-gonic/gin"
	"github.com/samber/lo"
	"github.com/shopspring/decimal"
)

func GetTopUpInfo(c *gin.Context) {
	complianceConfirmed := operation_setting.IsPaymentComplianceConfirmed()

	payMethods := []map[string]string{}
	if isEpayTopUpEnabled() {
		payMethods = operation_setting.PayMethods
	}

	// 如果启用了 Stripe 支付，添加到支付方法列表
	if isStripeTopUpEnabled() {
		// 检查是否已经包含 Stripe
		hasStripe := false
		for _, method := range payMethods {
			if method["type"] == "stripe" {
				hasStripe = true
				break
			}
		}

		if !hasStripe {
			stripeMethod := map[string]string{
				"name":      "Stripe",
				"type":      "stripe",
				"color":     "rgba(var(--semi-purple-5), 1)",
				"min_topup": strconv.Itoa(setting.StripeMinTopUp),
			}
			payMethods = append(payMethods, stripeMethod)
		}
	}

	// Waffo Pancake displayed above the legacy Waffo gateway.
	enableWaffoPancake := isWaffoPancakeTopUpEnabled()
	if enableWaffoPancake {
		hasWaffoPancake := false
		for _, method := range payMethods {
			if method["type"] == model.PaymentMethodWaffoPancake {
				hasWaffoPancake = true
				break
			}
		}

		if !hasWaffoPancake {
			payMethods = append(payMethods, map[string]string{
				"name":      "Waffo Pancake",
				"type":      model.PaymentMethodWaffoPancake,
				"color":     "rgba(var(--semi-orange-5), 1)",
				"min_topup": strconv.Itoa(setting.WaffoPancakeMinTopUp),
			})
		}
	}

	// 如果启用了 Waffo 支付，添加到支付方法列表
	enableWaffo := isWaffoTopUpEnabled()
	if enableWaffo {
		hasWaffo := false
		for _, method := range payMethods {
			if method["type"] == model.PaymentMethodWaffo {
				hasWaffo = true
				break
			}
		}

		if !hasWaffo {
			waffoMethod := map[string]string{
				"name":      "Waffo (Global Payment)",
				"type":      model.PaymentMethodWaffo,
				"color":     "rgba(var(--semi-blue-5), 1)",
				"min_topup": strconv.Itoa(setting.WaffoMinTopUp),
			}
			payMethods = append(payMethods, waffoMethod)
		}
	}

	manualTopUpMethods := getManualTopUpMethods()
	payMethods = append(payMethods, manualTopUpMethods...)

	data := gin.H{
		"enable_online_topup":              isEpayTopUpEnabled(),
		"enable_stripe_topup":              isStripeTopUpEnabled(),
		"enable_creem_topup":               isCreemTopUpEnabled(),
		"enable_waffo_topup":               enableWaffo,
		"enable_waffo_pancake_topup":       enableWaffoPancake,
		"enable_manual_topup":              len(manualTopUpMethods) > 0,
		"enable_redemption":                complianceConfirmed,
		"payment_compliance_confirmed":     complianceConfirmed,
		"payment_compliance_terms_version": operation_setting.CurrentComplianceTermsVersion,
		"waffo_pay_methods": func() interface{} {
			if enableWaffo {
				return setting.GetWaffoPayMethods()
			}
			return nil
		}(),
		"creem_products":          setting.CreemProducts,
		"pay_methods":             payMethods,
		"min_topup":               operation_setting.MinTopUp,
		"manual_topup_min_topup":  getManualTopupMinTopup(),
		"stripe_min_topup":        setting.StripeMinTopUp,
		"waffo_min_topup":         setting.WaffoMinTopUp,
		"waffo_pancake_min_topup": setting.WaffoPancakeMinTopUp,
		"amount_options":          operation_setting.GetPaymentSetting().AmountOptions,
		"discount":                operation_setting.GetPaymentSetting().AmountDiscount,
		"topup_link":              common.TopUpLink,
	}
	common.ApiSuccess(c, data)
}

type EpayRequest struct {
	Amount        int64  `json:"amount"`
	PaymentMethod string `json:"payment_method"`
}

type ManualTopUpRequest struct {
	Amount        int64  `json:"amount"`
	PaymentMethod string `json:"payment_method"`
}

type AmountRequest struct {
	Amount int64 `json:"amount"`
}

type manualTopUpMethod struct {
	Name   string
	Type   string
	Color  string
	QRCode string
}

type manualTopUpNotificationInput struct {
	UserID        int
	TradeNo       string
	PaymentName   string
	DisplayAmount int64
	PayMoney      float64
}

type manualTopUpNotification struct {
	Subject string
	Content string
}

func getManualTopupMinTopup() int64 {
	minTopup := operation_setting.ManualTopUpMinTopUp
	if minTopup <= 0 {
		minTopup = 1
	}
	if operation_setting.GetQuotaDisplayType() == operation_setting.QuotaDisplayTypeTokens {
		dMinTopup := decimal.NewFromInt(int64(minTopup))
		dQuotaPerUnit := decimal.NewFromFloat(common.QuotaPerUnit)
		minTopup = int(dMinTopup.Mul(dQuotaPerUnit).IntPart())
	}
	return int64(minTopup)
}

func getManualTopUpMethod(paymentMethod string) (manualTopUpMethod, bool) {
	if !isPaymentComplianceConfirmed() || !operation_setting.ManualTopUpEnabled {
		return manualTopUpMethod{}, false
	}

	switch paymentMethod {
	case model.PaymentMethodManualWechat:
		qrCode := strings.TrimSpace(operation_setting.ManualTopUpWechatQRCode)
		if qrCode == "" {
			return manualTopUpMethod{}, false
		}
		return manualTopUpMethod{
			Name:   "微信人工充值",
			Type:   model.PaymentMethodManualWechat,
			Color:  "rgba(var(--semi-green-5), 1)",
			QRCode: qrCode,
		}, true
	case model.PaymentMethodManualAlipay:
		qrCode := strings.TrimSpace(operation_setting.ManualTopUpAlipayQRCode)
		if qrCode == "" {
			return manualTopUpMethod{}, false
		}
		return manualTopUpMethod{
			Name:   "支付宝人工充值",
			Type:   model.PaymentMethodManualAlipay,
			Color:  "rgba(var(--semi-blue-5), 1)",
			QRCode: qrCode,
		}, true
	default:
		return manualTopUpMethod{}, false
	}
}

func getManualTopUpMethods() []map[string]string {
	methods := make([]map[string]string, 0, 2)
	for _, paymentMethod := range []string{model.PaymentMethodManualWechat, model.PaymentMethodManualAlipay} {
		method, ok := getManualTopUpMethod(paymentMethod)
		if !ok {
			continue
		}
		methods = append(methods, map[string]string{
			"name":      method.Name,
			"type":      method.Type,
			"color":     method.Color,
			"min_topup": strconv.FormatInt(getManualTopupMinTopup(), 10),
		})
	}
	return methods
}

func isManualTopUpEnabled() bool {
	return len(getManualTopUpMethods()) > 0
}

func normalizeTopUpAmountForStorage(amount int64) int64 {
	if operation_setting.GetQuotaDisplayType() != operation_setting.QuotaDisplayTypeTokens {
		return amount
	}
	dAmount := decimal.NewFromInt(amount)
	dQuotaPerUnit := decimal.NewFromFloat(common.QuotaPerUnit)
	return dAmount.Div(dQuotaPerUnit).IntPart()
}

func buildManualTopUpNotification(input manualTopUpNotificationInput) manualTopUpNotification {
	return manualTopUpNotification{
		Subject: "新的人工充值待确认",
		Content: fmt.Sprintf(
			"用户ID: %d\n订单号: %s\n收款方式: %s\n充值数量: %d\n应收金额: ¥%.2f\n请在后台充值记录确认到账后手工完成订单。",
			input.UserID,
			input.TradeNo,
			input.PaymentName,
			input.DisplayAmount,
			input.PayMoney,
		),
	}
}

func GetEpayClient() *epay.Client {
	if operation_setting.PayAddress == "" || operation_setting.EpayId == "" || operation_setting.EpayKey == "" {
		return nil
	}
	withUrl, err := epay.NewClient(&epay.Config{
		PartnerID: operation_setting.EpayId,
		Key:       operation_setting.EpayKey,
	}, operation_setting.PayAddress)
	if err != nil {
		return nil
	}
	return withUrl
}

func getPayMoney(amount int64, group string) float64 {
	dAmount := decimal.NewFromInt(amount)
	// 充值金额以“展示类型”为准：
	// - USD/CNY: 前端传 amount 为金额单位；TOKENS: 前端传 tokens，需要换成 USD 金额
	if operation_setting.GetQuotaDisplayType() == operation_setting.QuotaDisplayTypeTokens {
		dQuotaPerUnit := decimal.NewFromFloat(common.QuotaPerUnit)
		dAmount = dAmount.Div(dQuotaPerUnit)
	}

	topupGroupRatio := common.GetTopupGroupRatio(group)
	if topupGroupRatio == 0 {
		topupGroupRatio = 1
	}

	dTopupGroupRatio := decimal.NewFromFloat(topupGroupRatio)
	dPrice := decimal.NewFromFloat(operation_setting.Price)
	// apply optional preset discount by the original request amount (if configured), default 1.0
	discount := 1.0
	if ds, ok := operation_setting.GetPaymentSetting().AmountDiscount[int(amount)]; ok {
		if ds > 0 {
			discount = ds
		}
	}
	dDiscount := decimal.NewFromFloat(discount)

	payMoney := dAmount.Mul(dPrice).Mul(dTopupGroupRatio).Mul(dDiscount)

	return payMoney.InexactFloat64()
}

func getMinTopup() int64 {
	minTopup := operation_setting.MinTopUp
	if operation_setting.GetQuotaDisplayType() == operation_setting.QuotaDisplayTypeTokens {
		dMinTopup := decimal.NewFromInt(int64(minTopup))
		dQuotaPerUnit := decimal.NewFromFloat(common.QuotaPerUnit)
		minTopup = common.QuotaFromDecimal(dMinTopup.Mul(dQuotaPerUnit))
	}
	return int64(minTopup)
}

func RequestEpay(c *gin.Context) {
	var req EpayRequest
	err := c.ShouldBindJSON(&req)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "参数错误"})
		return
	}
	if req.Amount < getMinTopup() {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": fmt.Sprintf("充值数量不能小于 %d", getMinTopup())})
		return
	}

	id := c.GetInt("id")
	group, err := model.GetUserGroup(id, true)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "获取用户分组失败"})
		return
	}
	payMoney := getPayMoney(req.Amount, group)
	if payMoney < 0.01 {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "充值金额过低"})
		return
	}

	if !operation_setting.ContainsPayMethod(req.PaymentMethod) {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "支付方式不存在"})
		return
	}

	callBackAddress := service.GetCallbackAddress()
	returnUrl, _ := url.Parse(paymentReturnPath("/console/log"))
	notifyUrl, _ := url.Parse(callBackAddress + "/api/user/epay/notify")
	tradeNo := fmt.Sprintf("%s%d", common.GetRandomString(6), time.Now().Unix())
	tradeNo = fmt.Sprintf("USR%dNO%s", id, tradeNo)
	client := GetEpayClient()
	if client == nil {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "当前管理员未配置支付信息"})
		return
	}
	uri, params, err := client.Purchase(&epay.PurchaseArgs{
		Type:           req.PaymentMethod,
		ServiceTradeNo: tradeNo,
		Name:           fmt.Sprintf("TUC%d", req.Amount),
		Money:          strconv.FormatFloat(payMoney, 'f', 2, 64),
		Device:         epay.PC,
		NotifyUrl:      notifyUrl,
		ReturnUrl:      returnUrl,
	})
	if err != nil {
		logger.LogError(c.Request.Context(), fmt.Sprintf("易支付 拉起支付失败 user_id=%d trade_no=%s payment_method=%s amount=%d error=%q", id, tradeNo, req.PaymentMethod, req.Amount, err.Error()))
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "拉起支付失败"})
		return
	}
	amount := req.Amount
	if operation_setting.GetQuotaDisplayType() == operation_setting.QuotaDisplayTypeTokens {
		dAmount := decimal.NewFromInt(int64(amount))
		dQuotaPerUnit := decimal.NewFromFloat(common.QuotaPerUnit)
		amount = dAmount.Div(dQuotaPerUnit).IntPart()
	}
	topUp := &model.TopUp{
		UserId:          id,
		Amount:          amount,
		Money:           payMoney,
		TradeNo:         tradeNo,
		PaymentMethod:   req.PaymentMethod,
		PaymentProvider: model.PaymentProviderEpay,
		CreateTime:      time.Now().Unix(),
		Status:          common.TopUpStatusPending,
	}
	err = topUp.Insert()
	if err != nil {
		logger.LogError(c.Request.Context(), fmt.Sprintf("易支付 创建充值订单失败 user_id=%d trade_no=%s payment_method=%s amount=%d error=%q", id, tradeNo, req.PaymentMethod, req.Amount, err.Error()))
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "创建订单失败"})
		return
	}
	logger.LogInfo(c.Request.Context(), fmt.Sprintf("易支付 充值订单创建成功 user_id=%d trade_no=%s payment_method=%s amount=%d money=%.2f uri=%q params=%q", id, tradeNo, req.PaymentMethod, req.Amount, payMoney, uri, common.GetJsonString(params)))
	c.JSON(http.StatusOK, gin.H{"message": "success", "data": params, "url": uri})
}

func RequestManualTopUp(c *gin.Context) {
	var req ManualTopUpRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "参数错误"})
		return
	}

	if !isManualTopUpEnabled() {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "当前管理员未配置人工充值"})
		return
	}

	if req.Amount < getManualTopupMinTopup() {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": fmt.Sprintf("充值数量不能小于 %d", getManualTopupMinTopup())})
		return
	}

	manualMethod, ok := getManualTopUpMethod(req.PaymentMethod)
	if !ok {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "支付方式不存在"})
		return
	}

	id := c.GetInt("id")
	group, err := model.GetUserGroup(id, true)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "获取用户分组失败"})
		return
	}

	payMoney := getPayMoney(req.Amount, group)
	if payMoney < 0.01 {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "充值金额过低"})
		return
	}

	tradeNo := fmt.Sprintf("MANUSR%dNO%s%d", id, common.GetRandomString(6), time.Now().Unix())
	topUp := &model.TopUp{
		UserId:          id,
		Amount:          normalizeTopUpAmountForStorage(req.Amount),
		Money:           payMoney,
		TradeNo:         tradeNo,
		PaymentMethod:   req.PaymentMethod,
		PaymentProvider: model.PaymentProviderManualTopUp,
		CreateTime:      time.Now().Unix(),
		Status:          common.TopUpStatusPending,
	}
	if err := topUp.Insert(); err != nil {
		logger.LogError(c.Request.Context(), fmt.Sprintf("人工充值 创建充值订单失败 user_id=%d trade_no=%s payment_method=%s amount=%d error=%q", id, tradeNo, req.PaymentMethod, req.Amount, err.Error()))
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "创建订单失败"})
		return
	}

	notification := buildManualTopUpNotification(manualTopUpNotificationInput{
		UserID:        id,
		TradeNo:       tradeNo,
		PaymentName:   manualMethod.Name,
		DisplayAmount: req.Amount,
		PayMoney:      payMoney,
	})
	// fire-and-forget：优先通过 Bark 深链通知管理员，失败/未配置时回退到旧通知方式，
	// 异步发送避免 Bark 网络调用阻塞用户请求。
	gopool.Go(func() {
		if !service.NotifyRechargePending(id, tradeNo, manualMethod.Name, req.Amount, payMoney) {
			service.NotifyRootUser(dto.NotifyTypeManualTopUp, notification.Subject, notification.Content)
		}
	})
	logger.LogInfo(c.Request.Context(), fmt.Sprintf("人工充值 充值订单创建成功 user_id=%d trade_no=%s payment_method=%s amount=%d money=%.2f", id, tradeNo, req.PaymentMethod, req.Amount, payMoney))

	c.JSON(http.StatusOK, gin.H{
		"message": "success",
		"data": gin.H{
			"trade_no":       tradeNo,
			"amount":         topUp.Amount,
			"display_amount": req.Amount,
			"money":          payMoney,
			"payment_method": manualMethod.Type,
			"payment_name":   manualMethod.Name,
			"qr_url":         manualMethod.QRCode,
			"instructions":   operation_setting.ManualTopUpInstructions,
		},
	})
}

// tradeNo lock
var orderLocks sync.Map
var createLock sync.Mutex

// refCountedMutex 带引用计数的互斥锁，确保最后一个使用者才从 map 中删除
type refCountedMutex struct {
	mu       sync.Mutex
	refCount int
}

// LockOrder 尝试对给定订单号加锁
func LockOrder(tradeNo string) {
	createLock.Lock()
	var rcm *refCountedMutex
	if v, ok := orderLocks.Load(tradeNo); ok {
		rcm = v.(*refCountedMutex)
	} else {
		rcm = &refCountedMutex{}
		orderLocks.Store(tradeNo, rcm)
	}
	rcm.refCount++
	createLock.Unlock()
	rcm.mu.Lock()
}

// UnlockOrder 释放给定订单号的锁
func UnlockOrder(tradeNo string) {
	v, ok := orderLocks.Load(tradeNo)
	if !ok {
		return
	}
	rcm := v.(*refCountedMutex)
	rcm.mu.Unlock()

	createLock.Lock()
	rcm.refCount--
	if rcm.refCount == 0 {
		orderLocks.Delete(tradeNo)
	}
	createLock.Unlock()
}

func EpayNotify(c *gin.Context) {
	if !isEpayWebhookEnabled() {
		logger.LogWarn(c.Request.Context(), fmt.Sprintf("易支付 webhook 被拒绝 reason=webhook_disabled path=%q client_ip=%s", c.Request.RequestURI, c.ClientIP()))
		_, _ = c.Writer.Write([]byte("fail"))
		return
	}

	var params map[string]string

	if c.Request.Method == "POST" {
		// POST 请求：从 POST body 解析参数
		if err := c.Request.ParseForm(); err != nil {
			logger.LogError(c.Request.Context(), fmt.Sprintf("易支付 webhook POST 表单解析失败 path=%q client_ip=%s error=%q", c.Request.RequestURI, c.ClientIP(), err.Error()))
			_, _ = c.Writer.Write([]byte("fail"))
			return
		}
		params = lo.Reduce(lo.Keys(c.Request.PostForm), func(r map[string]string, t string, i int) map[string]string {
			r[t] = c.Request.PostForm.Get(t)
			return r
		}, map[string]string{})
	} else {
		// GET 请求：从 URL Query 解析参数
		params = lo.Reduce(lo.Keys(c.Request.URL.Query()), func(r map[string]string, t string, i int) map[string]string {
			r[t] = c.Request.URL.Query().Get(t)
			return r
		}, map[string]string{})
	}
	logger.LogInfo(c.Request.Context(), fmt.Sprintf("易支付 webhook 收到请求 path=%q client_ip=%s method=%s params=%q", c.Request.RequestURI, c.ClientIP(), c.Request.Method, common.GetJsonString(params)))

	if len(params) == 0 {
		logger.LogWarn(c.Request.Context(), fmt.Sprintf("易支付 webhook 参数为空 path=%q client_ip=%s", c.Request.RequestURI, c.ClientIP()))
		_, _ = c.Writer.Write([]byte("fail"))
		return
	}
	client := GetEpayClient()
	if client == nil {
		logger.LogError(c.Request.Context(), fmt.Sprintf("易支付 client 未初始化 path=%q client_ip=%s", c.Request.RequestURI, c.ClientIP()))
		_, err := c.Writer.Write([]byte("fail"))
		if err != nil {
			logger.LogError(c.Request.Context(), fmt.Sprintf("易支付 webhook 响应写入失败 path=%q client_ip=%s error=%q", c.Request.RequestURI, c.ClientIP(), err.Error()))
		}
		return
	}
	verifyInfo, err := client.Verify(params)
	if err != nil || !verifyInfo.VerifyStatus {
		if _, writeErr := c.Writer.Write([]byte("fail")); writeErr != nil {
			logger.LogError(c.Request.Context(), fmt.Sprintf("易支付 webhook 响应写入失败 path=%q client_ip=%s error=%q", c.Request.RequestURI, c.ClientIP(), writeErr.Error()))
		}
		if err != nil {
			logger.LogWarn(c.Request.Context(), fmt.Sprintf("易支付 webhook 验签失败 path=%q client_ip=%s verify_error=%q", c.Request.RequestURI, c.ClientIP(), err.Error()))
		} else {
			logger.LogWarn(c.Request.Context(), fmt.Sprintf("易支付 webhook 验签失败 path=%q client_ip=%s verify_status=false", c.Request.RequestURI, c.ClientIP()))
		}
		return
	}
	logger.LogInfo(c.Request.Context(), fmt.Sprintf("易支付 webhook 验签成功 trade_no=%s callback_type=%s trade_status=%s client_ip=%s verify_info=%q", verifyInfo.ServiceTradeNo, verifyInfo.Type, verifyInfo.TradeStatus, c.ClientIP(), common.GetJsonString(verifyInfo)))

	if verifyInfo.TradeStatus == epay.StatusTradeSuccess {
		// 进程内锁只是优化；重复/并发回调的正确性由 RechargeEpay 的
		// 数据库行锁 + 事务内状态校验保证（多实例部署下同样安全）。
		LockOrder(verifyInfo.ServiceTradeNo)
		defer UnlockOrder(verifyInfo.ServiceTradeNo)
		alreadyDone, err := model.RechargeEpay(verifyInfo.ServiceTradeNo, verifyInfo.Type, c.ClientIP())
		if err != nil {
			switch {
			case errors.Is(err, model.ErrTopUpNotFound):
				logger.LogWarn(c.Request.Context(), fmt.Sprintf("易支付 回调订单不存在 trade_no=%s callback_type=%s client_ip=%s verify_info=%q", verifyInfo.ServiceTradeNo, verifyInfo.Type, c.ClientIP(), common.GetJsonString(verifyInfo)))
			case errors.Is(err, model.ErrPaymentMethodMismatch):
				logger.LogWarn(c.Request.Context(), fmt.Sprintf("易支付 订单支付网关不匹配 trade_no=%s callback_type=%s client_ip=%s", verifyInfo.ServiceTradeNo, verifyInfo.Type, c.ClientIP()))
			case errors.Is(err, model.ErrTopUpStatusInvalid):
				logger.LogWarn(c.Request.Context(), fmt.Sprintf("易支付 订单状态非法 trade_no=%s callback_type=%s client_ip=%s", verifyInfo.ServiceTradeNo, verifyInfo.Type, c.ClientIP()))
			default:
				logger.LogError(c.Request.Context(), fmt.Sprintf("易支付 充值处理失败 trade_no=%s client_ip=%s error=%q", verifyInfo.ServiceTradeNo, c.ClientIP(), err.Error()))
			}
			if _, writeErr := c.Writer.Write([]byte("fail")); writeErr != nil {
				logger.LogError(c.Request.Context(), fmt.Sprintf("易支付 webhook 响应写入失败 trade_no=%s client_ip=%s error=%q", verifyInfo.ServiceTradeNo, c.ClientIP(), writeErr.Error()))
			}
			return
		}
		if alreadyDone {
			logger.LogInfo(c.Request.Context(), fmt.Sprintf("易支付 重复回调幂等忽略 trade_no=%s callback_type=%s client_ip=%s", verifyInfo.ServiceTradeNo, verifyInfo.Type, c.ClientIP()))
		} else {
			logger.LogInfo(c.Request.Context(), fmt.Sprintf("易支付 充值成功 trade_no=%s callback_type=%s client_ip=%s", verifyInfo.ServiceTradeNo, verifyInfo.Type, c.ClientIP()))
		}
	} else {
		logger.LogInfo(c.Request.Context(), fmt.Sprintf("易支付 webhook 忽略事件 trade_no=%s callback_type=%s trade_status=%s client_ip=%s verify_info=%q", verifyInfo.ServiceTradeNo, verifyInfo.Type, verifyInfo.TradeStatus, c.ClientIP(), common.GetJsonString(verifyInfo)))
	}
	if _, writeErr := c.Writer.Write([]byte("success")); writeErr != nil {
		logger.LogError(c.Request.Context(), fmt.Sprintf("易支付 webhook 响应写入失败 trade_no=%s client_ip=%s error=%q", verifyInfo.ServiceTradeNo, c.ClientIP(), writeErr.Error()))
	}
}

func RequestAmount(c *gin.Context) {
	var req AmountRequest
	err := c.ShouldBindJSON(&req)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "参数错误"})
		return
	}

	if req.Amount < getMinTopup() {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": fmt.Sprintf("充值数量不能小于 %d", getMinTopup())})
		return
	}
	id := c.GetInt("id")
	group, err := model.GetUserGroup(id, true)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "获取用户分组失败"})
		return
	}
	payMoney := getPayMoney(req.Amount, group)
	if payMoney <= 0.01 {
		c.JSON(http.StatusOK, gin.H{"message": "error", "data": "充值金额过低"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "success", "data": strconv.FormatFloat(payMoney, 'f', 2, 64)})
}

func GetUserTopUps(c *gin.Context) {
	userId := c.GetInt("id")
	pageInfo := common.GetPageQuery(c)
	keyword := c.Query("keyword")

	var (
		topups []*model.TopUp
		total  int64
		err    error
	)
	if keyword != "" {
		topups, total, err = model.SearchUserTopUps(userId, keyword, pageInfo)
	} else {
		topups, total, err = model.GetUserTopUps(userId, pageInfo)
	}
	if err != nil {
		common.ApiError(c, err)
		return
	}

	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(topups)
	common.ApiSuccess(c, pageInfo)
}

// GetAllTopUps 管理员获取全平台充值记录
func GetAllTopUps(c *gin.Context) {
	pageInfo := common.GetPageQuery(c)
	keyword := c.Query("keyword")

	var (
		topups []*model.TopUp
		total  int64
		err    error
	)
	if keyword != "" {
		topups, total, err = model.SearchAllTopUps(keyword, pageInfo)
	} else {
		topups, total, err = model.GetAllTopUps(pageInfo)
	}
	if err != nil {
		common.ApiError(c, err)
		return
	}

	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(topups)
	common.ApiSuccess(c, pageInfo)
}

// pendingManualTopUp 待确认人工充值订单的返回项（在原始订单基础上补充用户名/邮箱）。
type pendingManualTopUp struct {
	Id            int     `json:"id"`
	UserId        int     `json:"user_id"`
	Username      string  `json:"username"`
	Email         string  `json:"email"`
	Amount        int64   `json:"amount"`
	Money         float64 `json:"money"`
	PaymentMethod string  `json:"payment_method"`
	CreateTime    int64   `json:"create_time"`
	TradeNo       string  `json:"trade_no"`
	Status        string  `json:"status"`
}

// GetPendingManualTopUps 管理员获取待确认人工充值订单（分页），并批量拼装用户名/邮箱。
func GetPendingManualTopUps(c *gin.Context) {
	pageInfo := common.GetPageQuery(c)

	topups, total, err := model.GetPendingManualTopUps(pageInfo)
	if err != nil {
		common.ApiError(c, err)
		return
	}

	// 批量查询用户名/邮箱，避免 N+1
	userIDSet := make(map[int]struct{}, len(topups))
	for _, t := range topups {
		userIDSet[t.UserId] = struct{}{}
	}
	userIDs := make([]int, 0, len(userIDSet))
	for id := range userIDSet {
		userIDs = append(userIDs, id)
	}

	type userBrief struct {
		Id       int    `json:"id"`
		Username string `json:"username"`
		Email    string `json:"email"`
	}
	userMap := make(map[int]userBrief, len(userIDs))
	if len(userIDs) > 0 {
		var users []userBrief
		if err := model.DB.Model(&model.User{}).Select("id", "username", "email").Where("id IN ?", userIDs).Find(&users).Error; err != nil {
			common.ApiError(c, err)
			return
		}
		for _, u := range users {
			userMap[u.Id] = u
		}
	}

	items := make([]pendingManualTopUp, 0, len(topups))
	for _, t := range topups {
		u := userMap[t.UserId]
		items = append(items, pendingManualTopUp{
			Id:            t.Id,
			UserId:        t.UserId,
			Username:      u.Username,
			Email:         u.Email,
			Amount:        t.Amount,
			Money:         t.Money,
			PaymentMethod: t.PaymentMethod,
			CreateTime:    t.CreateTime,
			TradeNo:       t.TradeNo,
			Status:        t.Status,
		})
	}

	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(items)
	common.ApiSuccess(c, pageInfo)
}

type AdminCompleteTopupRequest struct {
	TradeNo string `json:"trade_no"`
	Amount  *int64 `json:"amount"` // 可选；仅人工充值订单生效，按该额度调整后补单
}

// AdminCompleteTopUp 管理员补单接口
func AdminCompleteTopUp(c *gin.Context) {
	var req AdminCompleteTopupRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.TradeNo == "" {
		common.ApiErrorMsg(c, "参数错误")
		return
	}

	// 订单级互斥，防止并发补单
	LockOrder(req.TradeNo)
	defer UnlockOrder(req.TradeNo)

	// Amount == nil：保持原有补单逻辑完全不变
	if req.Amount == nil {
		if err := model.ManualCompleteTopUp(req.TradeNo, c.ClientIP()); err != nil {
			common.ApiError(c, err)
			return
		}
		common.ApiSuccess(c, nil)
		return
	}

	// Amount != nil：仅人工充值订单支持调整金额
	topUp := model.GetTopUpByTradeNo(req.TradeNo)
	if topUp == nil {
		common.ApiErrorMsg(c, "充值订单不存在")
		return
	}
	if topUp.PaymentProvider != model.PaymentProviderManualTopUp {
		common.ApiErrorMsg(c, "仅人工充值订单支持调整金额")
		return
	}
	if err := model.AdminCompleteManualTopUp(req.TradeNo, *req.Amount, c.ClientIP()); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}

type ConfirmManualTopUpStatusRequest struct {
	TradeNos []string `json:"trade_nos"`
	All      bool     `json:"all"`
}

// ConfirmManualTopUpStatus 批量确认人工充值订单状态为已完成（仅改状态，不给用户充值）。
// 适用于历史上已在系统外手工充值、订单仍为待确认的情况。
func ConfirmManualTopUpStatus(c *gin.Context) {
	var req ConfirmManualTopUpStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiErrorMsg(c, "参数错误")
		return
	}
	if !req.All && len(req.TradeNos) == 0 {
		common.ApiErrorMsg(c, "未选择订单")
		return
	}

	count, err := model.ConfirmManualTopUpStatus(req.TradeNos, req.All)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	logger.LogInfo(c.Request.Context(), fmt.Sprintf("人工充值 批量确认状态(不充值) count=%d all=%v operator_ip=%s", count, req.All, c.ClientIP()))
	common.ApiSuccess(c, gin.H{"count": count})
}

// CancelManualTopUpStatus 批量作废人工充值订单（仅改为 failed，不给用户充值）。
func CancelManualTopUpStatus(c *gin.Context) {
	var req ConfirmManualTopUpStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiErrorMsg(c, "参数错误")
		return
	}
	if !req.All && len(req.TradeNos) == 0 {
		common.ApiErrorMsg(c, "未选择订单")
		return
	}

	count, err := model.CancelManualTopUpStatus(req.TradeNos, req.All)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	logger.LogInfo(c.Request.Context(), fmt.Sprintf("人工充值 批量作废 count=%d all=%v operator_ip=%s", count, req.All, c.ClientIP()))
	common.ApiSuccess(c, gin.H{"count": count})
}
