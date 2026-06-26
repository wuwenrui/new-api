package controller

import (
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type manualOrderFilters struct {
	Keyword        string
	Status         string
	StartTimestamp int64
	EndTimestamp   int64
}

type manualOrderBreakdown struct {
	Status string  `json:"status,omitempty"`
	Count  int64   `json:"count"`
	Money  float64 `json:"money"`
}

type manualMethodBreakdown struct {
	PaymentMethod string  `json:"payment_method"`
	Count         int64   `json:"count"`
	Money         float64 `json:"money"`
}

type manualOrderSummary struct {
	TotalCount   int64                   `json:"total_count"`
	PendingCount int64                   `json:"pending_count"`
	SuccessCount int64                   `json:"success_count"`
	FailedCount  int64                   `json:"failed_count"`
	ExpiredCount int64                   `json:"expired_count"`
	TotalMoney   float64                 `json:"total_money"`
	PendingMoney float64                 `json:"pending_money"`
	SuccessMoney float64                 `json:"success_money"`
	FailedMoney  float64                 `json:"failed_money"`
	ExpiredMoney float64                 `json:"expired_money"`
	ByStatus     []manualOrderBreakdown  `json:"by_status"`
	ByMethod     []manualMethodBreakdown `json:"by_method"`
}

type manualOrderPage[T any] struct {
	Items   []T                `json:"items"`
	Total   int                `json:"total"`
	Summary manualOrderSummary `json:"summary"`
}

type manualTopUpOrder struct {
	Id              int     `json:"id"`
	UserId          int     `json:"user_id"`
	Username        string  `json:"username"`
	Email           string  `json:"email"`
	Amount          int64   `json:"amount"`
	Money           float64 `json:"money"`
	PaymentMethod   string  `json:"payment_method"`
	PaymentProvider string  `json:"payment_provider"`
	CreateTime      int64   `json:"create_time"`
	CompleteTime    int64   `json:"complete_time"`
	TradeNo         string  `json:"trade_no"`
	Status          string  `json:"status"`
}

type manualSubscriptionOrder struct {
	Id              int     `json:"id"`
	UserId          int     `json:"user_id"`
	Username        string  `json:"username"`
	Email           string  `json:"email"`
	PlanId          int     `json:"plan_id"`
	PlanTitle       string  `json:"plan_title"`
	Money           float64 `json:"money"`
	PaymentMethod   string  `json:"payment_method"`
	PaymentProvider string  `json:"payment_provider"`
	CreateTime      int64   `json:"create_time"`
	CompleteTime    int64   `json:"complete_time"`
	TradeNo         string  `json:"trade_no"`
	Status          string  `json:"status"`
}

func manualOrderFiltersFromQuery(c *gin.Context) manualOrderFilters {
	startTimestamp, _ := strconv.ParseInt(c.Query("start_timestamp"), 10, 64)
	endTimestamp, _ := strconv.ParseInt(c.Query("end_timestamp"), 10, 64)
	return manualOrderFilters{
		Keyword:        strings.TrimSpace(c.Query("keyword")),
		Status:         strings.TrimSpace(c.Query("status")),
		StartTimestamp: startTimestamp,
		EndTimestamp:   endTimestamp,
	}
}

func manualReviewLikePattern(keyword string) string {
	escaped := strings.ReplaceAll(keyword, "!", "!!")
	escaped = strings.ReplaceAll(escaped, "%", "!%")
	escaped = strings.ReplaceAll(escaped, "_", "!_")
	return "%" + escaped + "%"
}

func applyManualOrderBaseFilters(query *gorm.DB, tableAlias string, filters manualOrderFilters) *gorm.DB {
	if filters.Status != "" && filters.Status != "all" {
		query = query.Where(tableAlias+".status = ?", filters.Status)
	}
	if filters.StartTimestamp > 0 {
		query = query.Where(tableAlias+".create_time >= ?", filters.StartTimestamp)
	}
	if filters.EndTimestamp > 0 {
		query = query.Where(tableAlias+".create_time < ?", filters.EndTimestamp)
	}
	return query
}

func buildManualTopUpOrderQuery(filters manualOrderFilters) *gorm.DB {
	query := model.DB.Table("top_ups AS tu").
		Joins("LEFT JOIN users AS u ON u.id = tu.user_id").
		Where("tu.payment_provider = ?", model.PaymentProviderManualTopUp)
	query = applyManualOrderBaseFilters(query, "tu", filters)
	if filters.Keyword != "" {
		pattern := manualReviewLikePattern(filters.Keyword)
		condition := "(tu.trade_no LIKE ? ESCAPE '!' OR u.username LIKE ? ESCAPE '!' OR u.email LIKE ? ESCAPE '!'"
		args := []interface{}{pattern, pattern, pattern}
		if userID, err := strconv.Atoi(filters.Keyword); err == nil {
			condition += " OR tu.user_id = ?"
			args = append(args, userID)
		}
		condition += ")"
		query = query.Where(condition, args...)
	}
	return query
}

func buildManualSubscriptionOrderQuery(filters manualOrderFilters) *gorm.DB {
	query := model.DB.Table("subscription_orders AS so").
		Joins("LEFT JOIN users AS u ON u.id = so.user_id").
		Joins("LEFT JOIN subscription_plans AS sp ON sp.id = so.plan_id").
		Where("so.payment_provider = ?", model.PaymentProviderManualSubscription)
	query = applyManualOrderBaseFilters(query, "so", filters)
	if filters.Keyword != "" {
		pattern := manualReviewLikePattern(filters.Keyword)
		condition := "(so.trade_no LIKE ? ESCAPE '!' OR u.username LIKE ? ESCAPE '!' OR u.email LIKE ? ESCAPE '!' OR sp.title LIKE ? ESCAPE '!'"
		args := []interface{}{pattern, pattern, pattern, pattern}
		if userID, err := strconv.Atoi(filters.Keyword); err == nil {
			condition += " OR so.user_id = ?"
			args = append(args, userID)
		}
		condition += ")"
		query = query.Where(condition, args...)
	}
	return query
}

func buildManualOrderSummary(query *gorm.DB, tableAlias string) (manualOrderSummary, error) {
	var byStatus []manualOrderBreakdown
	if err := query.Session(&gorm.Session{}).
		Select(tableAlias + ".status AS status, COUNT(*) AS count, COALESCE(SUM(" + tableAlias + ".money), 0) AS money").
		Group(tableAlias + ".status").
		Order(tableAlias + ".status ASC").
		Scan(&byStatus).Error; err != nil {
		return manualOrderSummary{}, err
	}

	var byMethod []manualMethodBreakdown
	if err := query.Session(&gorm.Session{}).
		Select(tableAlias + ".payment_method AS payment_method, COUNT(*) AS count, COALESCE(SUM(" + tableAlias + ".money), 0) AS money").
		Group(tableAlias + ".payment_method").
		Order(tableAlias + ".payment_method ASC").
		Scan(&byMethod).Error; err != nil {
		return manualOrderSummary{}, err
	}

	summary := manualOrderSummary{
		ByStatus: byStatus,
		ByMethod: byMethod,
	}
	for _, item := range byStatus {
		summary.TotalCount += item.Count
		summary.TotalMoney += item.Money
		switch item.Status {
		case common.TopUpStatusPending:
			summary.PendingCount = item.Count
			summary.PendingMoney = item.Money
		case common.TopUpStatusSuccess:
			summary.SuccessCount = item.Count
			summary.SuccessMoney = item.Money
		case common.TopUpStatusFailed:
			summary.FailedCount = item.Count
			summary.FailedMoney = item.Money
		case common.TopUpStatusExpired:
			summary.ExpiredCount = item.Count
			summary.ExpiredMoney = item.Money
		}
	}
	return summary, nil
}

func GetManualTopUpOrders(c *gin.Context) {
	pageInfo := common.GetPageQuery(c)
	filters := manualOrderFiltersFromQuery(c)
	query := buildManualTopUpOrderQuery(filters)

	var total int64
	if err := query.Session(&gorm.Session{}).Count(&total).Error; err != nil {
		common.ApiError(c, err)
		return
	}
	summary, err := buildManualOrderSummary(query, "tu")
	if err != nil {
		common.ApiError(c, err)
		return
	}

	var orders []manualTopUpOrder
	if err := query.Session(&gorm.Session{}).
		Select("tu.id, tu.user_id, u.username, u.email, tu.amount, tu.money, tu.payment_method, tu.payment_provider, tu.create_time, tu.complete_time, tu.trade_no, tu.status").
		Order("tu.id desc").
		Limit(pageInfo.GetPageSize()).
		Offset(pageInfo.GetStartIdx()).
		Scan(&orders).Error; err != nil {
		common.ApiError(c, err)
		return
	}

	common.ApiSuccess(c, manualOrderPage[manualTopUpOrder]{
		Items:   orders,
		Total:   int(total),
		Summary: summary,
	})
}

func GetManualSubscriptionOrders(c *gin.Context) {
	pageInfo := common.GetPageQuery(c)
	filters := manualOrderFiltersFromQuery(c)
	query := buildManualSubscriptionOrderQuery(filters)

	var total int64
	if err := query.Session(&gorm.Session{}).Count(&total).Error; err != nil {
		common.ApiError(c, err)
		return
	}
	summary, err := buildManualOrderSummary(query, "so")
	if err != nil {
		common.ApiError(c, err)
		return
	}

	var orders []manualSubscriptionOrder
	if err := query.Session(&gorm.Session{}).
		Select("so.id, so.user_id, u.username, u.email, so.plan_id, sp.title AS plan_title, so.money, so.payment_method, so.payment_provider, so.create_time, so.complete_time, so.trade_no, so.status").
		Order("so.id desc").
		Limit(pageInfo.GetPageSize()).
		Offset(pageInfo.GetStartIdx()).
		Scan(&orders).Error; err != nil {
		common.ApiError(c, err)
		return
	}

	common.ApiSuccess(c, manualOrderPage[manualSubscriptionOrder]{
		Items:   orders,
		Total:   int(total),
		Summary: summary,
	})
}
