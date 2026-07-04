package service

import (
	"fmt"
	"sort"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"gorm.io/gorm"
)

// FinanceOrderRow 财务报表订单明细行（充值订单与订阅订单共用；amount 仅充值有、plan_id 仅订阅有）。
type FinanceOrderRow struct {
	Id            int     `json:"id"`
	UserId        int     `json:"user_id"`
	Username      string  `json:"username"`
	Email         string  `json:"email"`
	Money         float64 `json:"money"`
	Amount        int64   `json:"amount"`
	PlanId        int     `json:"plan_id"`
	TradeNo       string  `json:"trade_no"`
	PaymentMethod string  `json:"payment_method"`
	Status        string  `json:"status"`
	CreateTime    int64   `json:"create_time"`
	CompleteTime  int64   `json:"complete_time"`
}

type FinanceOrderListParams struct {
	Table          string // "top_ups" 或 "subscription_orders"
	StartTimestamp int64
	EndTimestamp   int64
	Status         string // 空或 success=只看成功；all=全部；其他=精确匹配
	Username       string
	Offset         int
	Limit          int
}

func ListFinanceOrders(params FinanceOrderListParams) ([]FinanceOrderRow, int64, error) {
	if params.Table != "top_ups" && params.Table != "subscription_orders" {
		return nil, 0, fmt.Errorf("unsupported finance order table: %s", params.Table)
	}
	status := params.Status
	if status == "" {
		status = common.TopUpStatusSuccess
	}
	// 成功单按完成时间过滤；含未完成单时按创建时间过滤（pending 没有 complete_time）
	timeCol := params.Table + ".create_time"
	if status == common.TopUpStatusSuccess {
		timeCol = params.Table + ".complete_time"
	}

	buildQuery := func() *gorm.DB {
		query := model.DB.Table(params.Table).
			Joins("LEFT JOIN users ON users.id = " + params.Table + ".user_id").
			Where("users.username IS NULL OR users.username <> ?", financeReportExcludedUsername)
		if status != "all" {
			query = query.Where(params.Table+".status = ?", status)
		}
		if params.Username != "" {
			query = query.Where("users.username = ?", params.Username)
		}
		if params.StartTimestamp > 0 {
			query = query.Where(timeCol+" >= ?", params.StartTimestamp)
		}
		if params.EndTimestamp > 0 {
			query = query.Where(timeCol+" < ?", params.EndTimestamp)
		}
		return query
	}

	var total int64
	if err := buildQuery().Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var rows []FinanceOrderRow
	err := buildQuery().
		Select(params.Table + ".*, COALESCE(users.username, '') AS username, COALESCE(users.email, '') AS email").
		Order(params.Table + ".id DESC").
		Offset(params.Offset).Limit(params.Limit).
		Scan(&rows).Error
	return rows, total, err
}

// FinanceBalanceRow 逐用户余额拆解：可能退款卡片的明细。
// gifted_estimate = 余额 + 累计消费 - 累计充值，可能为负（前端展示时截 0）。
type FinanceBalanceRow struct {
	Username       string  `json:"username"`
	Balance        float64 `json:"balance"`
	TotalTopUp     float64 `json:"total_topup"`
	TotalConsumed  float64 `json:"total_consumed"`
	GiftedEstimate float64 `json:"gifted_estimate"`
}

func BuildFinanceBalances() ([]FinanceBalanceRow, error) {
	if common.QuotaPerUnit <= 0 {
		return nil, fmt.Errorf("quota per unit must be positive")
	}
	balanceByName, topupByName, err := financeUserSnapshots()
	if err != nil {
		return nil, err
	}

	type consumeRow struct {
		Username string
		Total    int64
	}
	var consumes []consumeRow
	if err := model.LOG_DB.Model(&model.Log{}).
		Select("username, COALESCE(SUM(quota), 0) AS total").
		Where("type = ?", model.LogTypeConsume).
		Where("username <> ?", financeReportExcludedUsername).
		Group("username").Scan(&consumes).Error; err != nil {
		return nil, err
	}
	consumedByName := map[string]float64{}
	for _, r := range consumes {
		consumedByName[r.Username] = float64(r.Total) / common.QuotaPerUnit
	}

	rows := make([]FinanceBalanceRow, 0, len(balanceByName))
	for username, balance := range balanceByName {
		topup := topupByName[username]
		if balance <= 0 && topup <= 0 {
			continue
		}
		consumed := consumedByName[username]
		rows = append(rows, FinanceBalanceRow{
			Username:       username,
			Balance:        balance,
			TotalTopUp:     topup,
			TotalConsumed:  consumed,
			GiftedEstimate: balance + consumed - topup,
		})
	}
	sort.Slice(rows, func(i int, j int) bool {
		if rows[i].Balance != rows[j].Balance {
			return rows[i].Balance > rows[j].Balance
		}
		return rows[i].Username < rows[j].Username
	})
	return rows, nil
}

// financeUserSnapshots 返回（按用户名索引的）当前余额与累计成功充值快照，均排除 wuwenrui。
// 软删除用户不出现在快照中（走 GORM 默认作用域），其历史充值现金仍计入 sumFinanceCash。
func financeUserSnapshots() (map[string]float64, map[string]float64, error) {
	type userRow struct {
		Id       int
		Username string
		Quota    int64
	}
	var users []userRow
	if err := model.DB.Model(&model.User{}).
		Select("id, username, quota").
		Where("username <> ?", financeReportExcludedUsername).
		Scan(&users).Error; err != nil {
		return nil, nil, err
	}
	idToName := map[int]string{}
	balanceByName := map[string]float64{}
	for _, u := range users {
		idToName[u.Id] = u.Username
		balanceByName[u.Username] = float64(u.Quota) / common.QuotaPerUnit
	}

	type sumRow struct {
		UserId int
		Total  float64
	}
	var sums []sumRow
	if err := model.DB.Table("top_ups").
		Select("user_id, COALESCE(SUM(money), 0) AS total").
		Where("status = ?", common.TopUpStatusSuccess).
		Group("user_id").Scan(&sums).Error; err != nil {
		return nil, nil, err
	}
	topupByName := map[string]float64{}
	for _, s := range sums {
		if name, ok := idToName[s.UserId]; ok {
			topupByName[name] = s.Total
		}
	}
	return balanceByName, topupByName, nil
}
