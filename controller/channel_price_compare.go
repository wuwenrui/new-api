package controller

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

// GetChannelPriceCompare 渠道价格对比面板：聚合本地价与上游实时价，按模型分组返回，
// 每个模型下的渠道按优先级降序排列，附输入/输出/缓存读写价格与盈利率。
func GetChannelPriceCompare(c *gin.Context) {
	report, err := service.BuildChannelPriceCompareReport(c.Request.Context(), c.Query("group"))
	if err != nil {
		common.SysError("failed to build channel operations report: " + err.Error())
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "Failed to load channel operations"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    report,
	})
}
