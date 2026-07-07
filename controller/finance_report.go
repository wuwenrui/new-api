package controller

import (
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

func GetFinanceReport(c *gin.Context) {
	startTimestamp, _ := strconv.ParseInt(c.Query("start_timestamp"), 10, 64)
	endTimestamp, _ := strconv.ParseInt(c.Query("end_timestamp"), 10, 64)
	channel, _ := strconv.Atoi(c.Query("channel"))

	report, err := service.BuildFinanceReport(service.FinanceReportParams{
		StartTimestamp: startTimestamp,
		EndTimestamp:   endTimestamp,
		ModelName:      c.Query("model_name"),
		Username:       c.Query("username"),
		Group:          c.Query("group"),
		Channel:        channel,
	})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, report)
}

func GetPACPriceMonitorReport(c *gin.Context) {
	startTimestamp, _ := strconv.ParseInt(c.Query("start_timestamp"), 10, 64)
	endTimestamp, _ := strconv.ParseInt(c.Query("end_timestamp"), 10, 64)
	channel, _ := strconv.Atoi(c.Query("channel"))

	report, err := service.BuildPACPriceMonitorReportWithLatestSnapshot(c.Request.Context(), service.PACPriceMonitorParams{
		StartTimestamp: startTimestamp,
		EndTimestamp:   endTimestamp,
		ModelName:      c.Query("model_name"),
		Channel:        channel,
	})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, report)
}

func GetFinanceTopUps(c *gin.Context) {
	getFinanceOrders(c, "top_ups")
}

func GetFinanceSubscriptionOrders(c *gin.Context) {
	getFinanceOrders(c, "subscription_orders")
}

func getFinanceOrders(c *gin.Context, table string) {
	pageInfo := common.GetPageQuery(c)
	startTimestamp, _ := strconv.ParseInt(c.Query("start_timestamp"), 10, 64)
	endTimestamp, _ := strconv.ParseInt(c.Query("end_timestamp"), 10, 64)
	rows, total, err := service.ListFinanceOrders(service.FinanceOrderListParams{
		Table:          table,
		StartTimestamp: startTimestamp,
		EndTimestamp:   endTimestamp,
		Status:         c.Query("status"),
		Username:       c.Query("username"),
		Offset:         pageInfo.GetStartIdx(),
		Limit:          pageInfo.GetPageSize(),
	})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(rows)
	common.ApiSuccess(c, pageInfo)
}

func GetFinanceBalances(c *gin.Context) {
	rows, err := service.BuildFinanceBalances()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, rows)
}
