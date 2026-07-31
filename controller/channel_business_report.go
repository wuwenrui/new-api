package controller

import (
	"net/http"
	"strconv"

	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

// GetChannelBusinessReport 渠道经营报表：按渠道聚合区间收入、估算上游成本、
// 毛利/毛利率、Top 模型与上游调价/低余额标记。days 默认 30，上限 90。
func GetChannelBusinessReport(c *gin.Context) {
	days := 0
	if raw := c.Query("days"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"success": false, "message": "days 必须是整数"})
			return
		}
		days = parsed
	}
	report, err := service.BuildChannelBusinessReport(c.Request.Context(), service.ChannelBusinessReportParams{Days: days})
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    report,
	})
}
