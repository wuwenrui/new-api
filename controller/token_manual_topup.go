package controller

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
)

func manualFacadeError(c *gin.Context, status int, err error) {
	c.JSON(status, gin.H{"success": false, "message": err.Error()})
}

func parseManualFacadeBody(c *gin.Context) (ManualTopUpRequest, error) {
	var req ManualTopUpRequest
	if c.Request.URL.RawQuery != "" {
		return req, errors.New("不接受查询参数")
	}
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, 1024))
	if err != nil {
		return req, errors.New("请求体过大或无效")
	}
	var fields map[string]json.RawMessage
	if common.Unmarshal(body, &fields) != nil || len(fields) != 2 {
		return req, errors.New("参数错误")
	}
	if len(fields["amount"]) == 0 || len(fields["payment_method"]) == 0 || string(fields["amount"]) == "null" || string(fields["payment_method"]) == "null" {
		return req, errors.New("参数错误")
	}
	if common.DecodeJsonStrict(bytes.NewReader(body), &req) != nil {
		return req, errors.New("参数错误")
	}
	return req, nil
}

func GetTokenManualTopUpOptions(c *gin.Context) {
	if c.Request.URL.RawQuery != "" {
		manualFacadeError(c, 400, errors.New("不接受查询参数"))
		return
	}
	minimum, step, err := manualTopUpUnits()
	if err != nil {
		manualFacadeError(c, 503, err)
		return
	}
	methods := make([]gin.H, 0, 2)
	for _, method := range getManualTopUpMethods() {
		methods = append(methods, gin.H{"id": method["type"], "name": method["name"]})
	}
	amounts := make([]int64, 0)
	for _, amount := range operation_setting.GetPaymentSetting().AmountOptions {
		value := int64(amount)
		if value >= minimum && value%step == 0 && value <= getMaxTopUpAmount() {
			amounts = append(amounts, value)
		}
	}
	common.ApiSuccess(c, gin.H{"version": 1, "enabled": len(methods) > 0, "min_amount": minimum,
		"amount_step": step, "amount_options": amounts, "payment_currency": "CNY", "methods": methods,
		"instructions": operation_setting.ManualTopUpInstructions})
}

func QuoteTokenManualTopUp(c *gin.Context) {
	req, err := parseManualFacadeBody(c)
	if err != nil {
		manualFacadeError(c, 400, err)
		return
	}
	quote, err := quoteManualTopUp(c.GetInt("id"), req)
	if err != nil {
		manualFacadeError(c, 400, err)
		return
	}
	common.ApiSuccess(c, quote)
}

func CreateTokenManualTopUp(c *gin.Context) {
	req, err := parseManualFacadeBody(c)
	if err != nil {
		manualFacadeError(c, 400, err)
		return
	}
	data, err := createManualTopUp(c, req)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errManualTopUpInsert) {
			// A database transport failure may leave an ambiguous insert outcome.
			status = http.StatusServiceUnavailable
		}
		manualFacadeError(c, status, err)
		return
	}
	common.ApiSuccess(c, data)
}

func GetTokenManualTopUpOrders(c *gin.Context) {
	query, err := url.ParseQuery(c.Request.URL.RawQuery)
	page, size := 1, 20
	if err == nil {
		for key, values := range query {
			if (key != "p" && key != "page_size") || len(values) != 1 {
				err = errors.New("无效分页参数")
				break
			}
			value, parseErr := strconv.Atoi(values[0])
			if parseErr != nil || value <= 0 || (key == "p" && value > 1000000) || (key == "page_size" && value > 100) {
				err = errors.New("无效分页参数")
				break
			}
			if key == "p" {
				page = value
			} else {
				size = value
			}
		}
	}
	if err != nil {
		manualFacadeError(c, 400, errors.New("无效分页参数"))
		return
	}
	items, total, err := model.GetUserManualTopUpHistory(c.GetInt("id"), (page-1)*size, size)
	if err != nil {
		manualFacadeError(c, 500, errors.New("获取充值记录失败"))
		return
	}
	common.ApiSuccess(c, gin.H{"page": page, "page_size": size, "total": total, "items": items})
}
