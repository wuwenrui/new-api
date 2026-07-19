package controller

import (
	"fmt"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/bytedance/gopkg/util/gopool"
	"github.com/gin-gonic/gin"
)

type EntitlementsSelfResponse struct {
	Features     map[string]bool                                 `json:"features"`
	Entitlements map[string]model.SubscriptionFeatureEntitlement `json:"entitlements"`
}

func GetEntitlementsSelf(c *gin.Context) {
	userId := c.GetInt("id")
	entitlements, err := model.GetActiveSubscriptionFeatureEntitlements(userId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	features := make(map[string]bool, len(model.SubscriptionFeatureKeys))
	for _, featureKey := range model.SubscriptionFeatureKeys {
		features[featureKey] = operation_setting.IsSubscriptionFeatureFree(featureKey)
	}
	for featureKey := range entitlements {
		features[featureKey] = true
	}
	common.ApiSuccess(c, EntitlementsSelfResponse{
		Features:     features,
		Entitlements: entitlements,
	})
}

func GetWechatBridgeSubscriptionPlans(c *gin.Context) {
	if !operation_setting.IsPaymentComplianceConfirmed() {
		common.ApiSuccess(c, []SubscriptionPlanDTO{})
		return
	}
	var plans []model.SubscriptionPlan
	if err := model.DB.
		Where("enabled = ?", true).
		Order("sort_order desc, id desc").
		Find(&plans).Error; err != nil {
		common.ApiError(c, err)
		return
	}
	result := make([]SubscriptionPlanDTO, 0, len(plans))
	for _, plan := range plans {
		plan.NormalizeDefaults()
		if !plan.HasFeature(model.SubscriptionFeatureWechatBridge) {
			continue
		}
		result = append(result, SubscriptionPlanDTO{Plan: plan})
	}
	common.ApiSuccess(c, result)
}

type RequestWechatBridgeManualSubscriptionRequest struct {
	PlanId        int    `json:"plan_id"`
	PaymentMethod string `json:"payment_method"`
}

func RequestWechatBridgeManualSubscription(c *gin.Context) {
	if !requirePaymentCompliance(c) {
		return
	}
	var req RequestWechatBridgeManualSubscriptionRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.PlanId <= 0 {
		common.ApiErrorMsg(c, "参数错误")
		return
	}
	manualMethod, ok := getManualTopUpMethod(req.PaymentMethod)
	if !ok {
		common.ApiErrorMsg(c, "支付方式不存在")
		return
	}
	plan, err := model.GetSubscriptionPlanById(req.PlanId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if !plan.Enabled {
		common.ApiErrorMsg(c, "套餐未启用")
		return
	}
	if !plan.HasFeature(model.SubscriptionFeatureWechatBridge) {
		common.ApiErrorMsg(c, "该套餐不包含微信高级功能")
		return
	}
	if plan.PriceAmount < 0.01 {
		common.ApiErrorMsg(c, "套餐金额过低")
		return
	}

	userId := c.GetInt("id")
	if plan.MaxPurchasePerUser > 0 {
		count, err := model.CountUserSubscriptionsByPlan(userId, plan.Id)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		if count >= int64(plan.MaxPurchasePerUser) {
			common.ApiErrorMsg(c, "已达到该套餐购买上限")
			return
		}
	}

	tradeNo := fmt.Sprintf("SUBMANUSR%dNO%s%d", userId, common.GetRandomString(6), time.Now().Unix())
	order := &model.SubscriptionOrder{
		UserId:          userId,
		PlanId:          plan.Id,
		Money:           plan.PriceAmount,
		TradeNo:         tradeNo,
		PaymentMethod:   manualMethod.Type,
		PaymentProvider: model.PaymentProviderManualSubscription,
		CreateTime:      time.Now().Unix(),
		Status:          common.TopUpStatusPending,
	}
	if err := order.Insert(); err != nil {
		common.ApiErrorMsg(c, "创建订单失败")
		return
	}

	gopool.Go(func() {
		if !service.NotifySubscriptionPending(userId, tradeNo, plan.Title, manualMethod.Name, plan.PriceAmount) {
			content := fmt.Sprintf(
				"用户ID: %d\n订单号: %s\n套餐: %s\n收款方式: %s\n应收金额: ¥%.2f\n请在后台订阅待确认页面确认到账后完成订单。",
				userId,
				tradeNo,
				plan.Title,
				manualMethod.Name,
				plan.PriceAmount,
			)
			service.NotifyRootUser(dto.NotifyTypeManualSubscription, "新的人工订阅待确认", content)
		}
	})

	common.ApiSuccess(c, gin.H{
		"trade_no":       tradeNo,
		"money":          plan.PriceAmount,
		"payment_method": manualMethod.Type,
		"payment_name":   manualMethod.Name,
		"qr_url":         manualMethod.QRCode,
		"instructions":   operation_setting.ManualTopUpInstructions,
		"plan":           plan,
	})
}

type PendingManualSubscriptionOrder struct {
	Id            int     `json:"id"`
	UserId        int     `json:"user_id"`
	Username      string  `json:"username"`
	Email         string  `json:"email"`
	PlanId        int     `json:"plan_id"`
	PlanTitle     string  `json:"plan_title"`
	Money         float64 `json:"money"`
	PaymentMethod string  `json:"payment_method"`
	CreateTime    int64   `json:"create_time"`
	TradeNo       string  `json:"trade_no"`
	Status        string  `json:"status"`
}

func GetPendingManualSubscriptions(c *gin.Context) {
	pageInfo := common.GetPageQuery(c)
	var total int64
	query := model.DB.Table("subscription_orders AS so").
		Joins("LEFT JOIN users AS u ON u.id = so.user_id").
		Joins("LEFT JOIN subscription_plans AS sp ON sp.id = so.plan_id").
		Where("so.payment_provider = ? AND so.status = ?", model.PaymentProviderManualSubscription, common.TopUpStatusPending)
	if err := query.Count(&total).Error; err != nil {
		common.ApiError(c, err)
		return
	}
	var orders []PendingManualSubscriptionOrder
	if err := query.
		Select("so.id, so.user_id, u.username, u.email, so.plan_id, sp.title AS plan_title, so.money, so.payment_method, so.create_time, so.trade_no, so.status").
		Order("so.id desc").
		Limit(pageInfo.GetPageSize()).
		Offset(pageInfo.GetStartIdx()).
		Scan(&orders).Error; err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(orders)
	common.ApiSuccess(c, pageInfo)
}

type AdminCompleteManualSubscriptionRequest struct {
	TradeNo string `json:"trade_no"`
}

func AdminCompleteManualSubscription(c *gin.Context) {
	var req AdminCompleteManualSubscriptionRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.TradeNo == "" {
		common.ApiErrorMsg(c, "参数错误")
		return
	}
	LockOrder(req.TradeNo)
	defer UnlockOrder(req.TradeNo)

	providerPayload := "manual_subscription_approved"
	if ip := c.ClientIP(); ip != "" {
		providerPayload += ": " + ip
	}
	if err := model.CompleteSubscriptionOrder(req.TradeNo, providerPayload, model.PaymentProviderManualSubscription, ""); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}

type ConfirmManualSubscriptionStatusRequest struct {
	TradeNos []string `json:"trade_nos"`
	All      bool     `json:"all"`
}

func ConfirmManualSubscriptionStatus(c *gin.Context) {
	var req ConfirmManualSubscriptionStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiErrorMsg(c, "参数错误")
		return
	}
	if !req.All && len(req.TradeNos) == 0 {
		common.ApiErrorMsg(c, "未选择订单")
		return
	}
	query := model.DB.Model(&model.SubscriptionOrder{}).
		Where("payment_provider = ? AND status = ?", model.PaymentProviderManualSubscription, common.TopUpStatusPending)
	if !req.All {
		query = query.Where("trade_no IN ?", req.TradeNos)
	}
	result := query.Updates(map[string]interface{}{
		"status":        common.TopUpStatusSuccess,
		"complete_time": common.GetTimestamp(),
	})
	if result.Error != nil {
		common.ApiError(c, result.Error)
		return
	}
	common.ApiSuccess(c, gin.H{"count": result.RowsAffected})
}
