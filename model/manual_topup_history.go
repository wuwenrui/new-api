package model

import "errors"

// ManualTopUpHistoryItem is the owner-facing receipt summary. Internal quota,
// owner IDs and provider bookkeeping are intentionally not exposed.
type ManualTopUpHistoryItem struct {
	TradeNo       string  `json:"trade_no"`
	Money         float64 `json:"money"`
	PaymentMethod string  `json:"payment_method"`
	Status        string  `json:"status"`
	CreateTime    int64   `json:"create_time"`
	CompleteTime  int64   `json:"complete_time"`
}

// GetUserManualTopUpHistory returns only this owner's manual wallet orders from
// the last 30 days. All restrictions apply before both counting and pagination.
func GetUserManualTopUpHistory(userID, startIdx, num int) ([]*ManualTopUpHistoryItem, int64, error) {
	items := make([]*ManualTopUpHistoryItem, 0)
	if userID <= 0 || startIdx < 0 || num <= 0 {
		return items, 0, errors.New("invalid manual top-up history pagination or owner")
	}
	query := DB.Model(&TopUp{}).
		Where("user_id = ? AND payment_provider = ?", userID, PaymentProviderManualTopUp).
		Where("create_time >= ?", topUpQueryCutoff())
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return items, 0, err
	}
	err := query.Select("trade_no", "money", "payment_method", "status", "create_time", "complete_time").
		Order("id DESC").Offset(startIdx).Limit(num).Scan(&items).Error
	return items, total, err
}
