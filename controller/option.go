package controller

import (
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/billing_setting"
	"github.com/QuantumNous/new-api/setting/console_setting"
	"github.com/QuantumNous/new-api/setting/model_setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"

	"github.com/gin-gonic/gin"
)

var completionRatioMetaOptionKeys = []string{
	"ModelPrice",
	"ModelOriginalPrice",
	"ModelRatio",
	"CompletionRatio",
	"CacheRatio",
	"CreateCacheRatio",
	"ImageRatio",
	"AudioRatio",
	"AudioCompletionRatio",
}

func isPaymentComplianceOptionKey(key string) bool {
	return strings.HasPrefix(key, "payment_setting.compliance_")
}

func isPositiveOptionValue(value string) bool {
	intValue, err := strconv.Atoi(strings.TrimSpace(value))
	if err == nil {
		return intValue > 0
	}
	floatValue, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	return err == nil && floatValue > 0
}

func collectModelNamesFromOptionValue(raw string, modelNames map[string]struct{}) {
	if strings.TrimSpace(raw) == "" {
		return
	}

	var parsed map[string]any
	if err := common.UnmarshalJsonStr(raw, &parsed); err != nil {
		return
	}

	for modelName := range parsed {
		modelNames[modelName] = struct{}{}
	}
}

func buildCompletionRatioMetaValue(optionValues map[string]string, requestedModel string) string {
	modelNames := make(map[string]struct{})
	if requestedModel = strings.TrimSpace(requestedModel); requestedModel != "" {
		modelNames[requestedModel] = struct{}{}
	}
	for _, key := range completionRatioMetaOptionKeys {
		collectModelNamesFromOptionValue(optionValues[key], modelNames)
	}

	meta := make(map[string]ratio_setting.CompletionRatioInfo, len(modelNames))
	for modelName := range modelNames {
		meta[modelName] = ratio_setting.GetCompletionRatioInfo(modelName)
	}

	jsonBytes, err := common.Marshal(meta)
	if err != nil {
		return "{}"
	}
	return string(jsonBytes)
}

func GetOptions(c *gin.Context) {
	var options []*model.Option
	optionValues := make(map[string]string)
	requestedModel := strings.TrimSpace(c.Query("model"))
	ratio_setting.ReadPricingSnapshot(func() {
		common.OptionMapRWMutex.RLock()
		for key, rawValue := range common.OptionMap {
			value := common.Interface2String(rawValue)
			isSensitiveKey := strings.HasSuffix(key, "Token") ||
				strings.HasSuffix(key, "Secret") ||
				strings.HasSuffix(key, "Key") ||
				strings.HasSuffix(key, "secret") ||
				strings.HasSuffix(key, "api_key")
			if isSensitiveKey {
				continue
			}
			options = append(options, &model.Option{Key: key, Value: value})
			for _, optionKey := range completionRatioMetaOptionKeys {
				if optionKey == key {
					optionValues[key] = value
					break
				}
			}
		}
		common.OptionMapRWMutex.RUnlock()
		options = append(options, &model.Option{
			Key:   "CompletionRatioMeta",
			Value: buildCompletionRatioMetaValue(optionValues, requestedModel),
		})
		if requestedModel == "" {
			return
		}
		pricingModelKey := ratio_setting.FormatMatchingModelName(requestedModel)
		if _, usesFixedPrice, fixedPriceKey := ratio_setting.GetModelPriceInfo(requestedModel, false); usesFixedPrice {
			pricingModelKey = fixedPriceKey
		}
		options = append(options, &model.Option{
			Key:   "PricingModelKey",
			Value: pricingModelKey,
		})
	})
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    options,
	})
}

type OptionUpdateRequest struct {
	Key   string `json:"key"`
	Value any    `json:"value"`
}

type PricingOptionsUpdateRequest struct {
	ModelName        string   `json:"model_name"`
	ModelRatio       float64  `json:"model_ratio"`
	CompletionRatio  *float64 `json:"completion_ratio"`
	CacheRatio       *float64 `json:"cache_ratio"`
	CreateCacheRatio *float64 `json:"create_cache_ratio"`
}

type pricingOptionMap struct {
	key   string
	value map[string]float64
}

func marshalPricingOptionMaps(optionMaps []pricingOptionMap) (map[string]string, []string, error) {
	values := make(map[string]string, len(optionMaps))
	keys := make([]string, 0, len(optionMaps))
	for _, option := range optionMaps {
		jsonBytes, err := common.Marshal(option.value)
		if err != nil {
			return nil, nil, err
		}
		values[option.key] = string(jsonBytes)
		keys = append(keys, option.key)
	}
	return values, keys, nil
}

var errSharedFixedPrice = errors.New("共享固定价格规则不能按单模型同步")

func validatePricingOptionsRequest(request PricingOptionsUpdateRequest) error {
	modelName := strings.TrimSpace(request.ModelName)
	if modelName == "" || !isFiniteNonNegative(request.ModelRatio) || request.ModelRatio == 0 ||
		request.CacheRatio == nil || !isFiniteNonNegative(*request.CacheRatio) ||
		request.CreateCacheRatio == nil || !isFiniteNonNegative(*request.CreateCacheRatio) {
		return fmt.Errorf("模型名称或定价值无效")
	}
	if billing_setting.GetBillingMode(modelName) == billing_setting.BillingModeTieredExpr {
		return fmt.Errorf("该模型使用分层计费表达式，不能同步倍率售价")
	}
	if _, usesFixedPrice, fixedPriceKey := ratio_setting.GetModelPriceInfo(modelName, false); usesFixedPrice &&
		fixedPriceKey == ratio_setting.CompactWildcardModelKey {
		return errSharedFixedPrice
	}
	if request.CompletionRatio == nil {
		return nil
	}
	if ratio_setting.GetCompletionRatioInfo(modelName).Locked {
		return fmt.Errorf("输出倍率由系统锁定，不能修改")
	}
	if !isFiniteNonNegative(*request.CompletionRatio) {
		return fmt.Errorf("输出倍率无效")
	}
	return nil
}

func pricingOptionMapValue(rawValues map[string]string, key string, fallback map[string]float64) (map[string]float64, error) {
	raw := strings.TrimSpace(rawValues[key])
	if raw == "" {
		return fallback, nil
	}
	values := make(map[string]float64)
	if err := common.UnmarshalJsonStr(raw, &values); err != nil {
		return nil, fmt.Errorf("%s 定价配置无效: %w", key, err)
	}
	if values == nil {
		return nil, fmt.Errorf("%s 定价配置必须是 JSON 对象", key)
	}
	return values, nil
}

func fixedPriceKey(modelName string, modelPrices map[string]float64) (string, bool) {
	pricingModelName := ratio_setting.FormatMatchingModelName(modelName)
	if _, exists := modelPrices[pricingModelName]; exists {
		return pricingModelName, true
	}
	if strings.HasSuffix(pricingModelName, ratio_setting.CompactModelSuffix) {
		if _, exists := modelPrices[ratio_setting.CompactWildcardModelKey]; exists {
			return ratio_setting.CompactWildcardModelKey, true
		}
	}
	return "", false
}

func buildPricingOptionValues(request PricingOptionsUpdateRequest) (map[string]string, []string, error) {
	return buildPricingOptionValuesFromCurrent(request, nil)
}

func buildPricingOptionValuesFromCurrent(request PricingOptionsUpdateRequest, current map[string]string) (map[string]string, []string, error) {
	if err := validatePricingOptionsRequest(request); err != nil {
		return nil, nil, err
	}
	modelName := strings.TrimSpace(request.ModelName)
	pricingModelName := ratio_setting.FormatMatchingModelName(modelName)

	modelRatios, err := pricingOptionMapValue(current, "ModelRatio", ratio_setting.GetModelRatioCopy())
	if err != nil {
		return nil, nil, err
	}
	cacheRatios, err := pricingOptionMapValue(current, "CacheRatio", ratio_setting.GetCacheRatioCopy())
	if err != nil {
		return nil, nil, err
	}
	createCacheRatios, err := pricingOptionMapValue(current, "CreateCacheRatio", ratio_setting.GetCreateCacheRatioCopy())
	if err != nil {
		return nil, nil, err
	}
	modelRatios[pricingModelName] = request.ModelRatio
	cacheRatios[modelName] = *request.CacheRatio
	createCacheRatios[modelName] = *request.CreateCacheRatio
	optionMaps := []pricingOptionMap{
		{key: "ModelRatio", value: modelRatios},
		{key: "CacheRatio", value: cacheRatios},
		{key: "CreateCacheRatio", value: createCacheRatios},
	}
	if request.CompletionRatio != nil {
		completionRatios, err := pricingOptionMapValue(current, "CompletionRatio", ratio_setting.GetCompletionRatioCopy())
		if err != nil {
			return nil, nil, err
		}
		completionRatios[pricingModelName] = *request.CompletionRatio
		optionMaps = append(optionMaps, pricingOptionMap{key: "CompletionRatio", value: completionRatios})
	}
	modelPrices, err := pricingOptionMapValue(current, "ModelPrice", ratio_setting.GetModelPriceCopy())
	if err != nil {
		return nil, nil, err
	}
	if matchedKey, usesFixedPrice := fixedPriceKey(modelName, modelPrices); usesFixedPrice {
		if matchedKey == ratio_setting.CompactWildcardModelKey {
			return nil, nil, errSharedFixedPrice
		}
		delete(modelPrices, matchedKey)
	}
	optionMaps = append(optionMaps, pricingOptionMap{key: "ModelPrice", value: modelPrices})
	return marshalPricingOptionMaps(optionMaps)
}

func isFiniteNonNegative(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}

func UpdatePricingOptions(c *gin.Context) {
	var request PricingOptionsUpdateRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "无效的定价参数"})
		return
	}
	if err := validatePricingOptionsRequest(request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
		return
	}
	var updatedKeys []string
	_, err := model.UpdateOptionsAtomically(
		[]string{"ModelRatio", "CompletionRatio", "CacheRatio", "CreateCacheRatio", "ModelPrice"},
		func(current map[string]string) (map[string]string, error) {
			values, keys, err := buildPricingOptionValuesFromCurrent(request, current)
			updatedKeys = keys
			return values, err
		},
	)
	if err != nil {
		if model.IsOptionUpdateConflict(err) {
			c.JSON(http.StatusConflict, gin.H{
				"success": false,
				"message": "计价配置正在被其他操作修改，请重试",
			})
			return
		}
		if errors.Is(err, errSharedFixedPrice) {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": err.Error()})
			return
		}
		common.ApiError(c, err)
		return
	}
	recordManageAudit(c, "option.pricing.update", map[string]interface{}{
		"model": strings.TrimSpace(request.ModelName),
		"keys":  updatedKeys,
	})
	c.JSON(http.StatusOK, gin.H{"success": true, "message": ""})
}

func UpdateOption(c *gin.Context) {
	var option OptionUpdateRequest
	err := common.DecodeJson(c.Request.Body, &option)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"success": false,
			"message": "无效的参数",
		})
		return
	}
	switch option.Value.(type) {
	case bool:
		option.Value = common.Interface2String(option.Value.(bool))
	case float64:
		option.Value = common.Interface2String(option.Value.(float64))
	case int:
		option.Value = common.Interface2String(option.Value.(int))
	default:
		option.Value = fmt.Sprintf("%v", option.Value)
	}
	switch option.Key {
	case "QuotaForInviter", "QuotaForInvitee":
		if isPositiveOptionValue(option.Value.(string)) && !operation_setting.IsPaymentComplianceConfirmed() {
			common.ApiErrorI18n(c, i18n.MsgPaymentComplianceRequired)
			return
		}
	default:
		if isPaymentComplianceOptionKey(option.Key) {
			common.ApiErrorMsg(c, "合规确认字段不允许通过通用设置接口修改")
			return
		}
	}
	switch option.Key {
	case "GitHubOAuthEnabled":
		if option.Value == "true" && common.GitHubClientId == "" {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": "无法启用 GitHub OAuth，请先填入 GitHub Client Id 以及 GitHub Client Secret！",
			})
			return
		}
	case "discord.enabled":
		if option.Value == "true" && system_setting.GetDiscordSettings().ClientId == "" {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": "无法启用 Discord OAuth，请先填入 Discord Client Id 以及 Discord Client Secret！",
			})
			return
		}
	case "oidc.enabled":
		if option.Value == "true" && system_setting.GetOIDCSettings().ClientId == "" {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": "无法启用 OIDC 登录，请先填入 OIDC Client Id 以及 OIDC Client Secret！",
			})
			return
		}
	case "LinuxDOOAuthEnabled":
		if option.Value == "true" && common.LinuxDOClientId == "" {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": "无法启用 LinuxDO OAuth，请先填入 LinuxDO Client Id 以及 LinuxDO Client Secret！",
			})
			return
		}
	case "EmailDomainRestrictionEnabled":
		if option.Value == "true" && len(common.EmailDomainWhitelist) == 0 {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": "无法启用邮箱域名限制，请先填入限制的邮箱域名！",
			})
			return
		}
	case "WeChatAuthEnabled":
		if option.Value == "true" && common.WeChatServerAddress == "" {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": "无法启用微信登录，请先填入微信登录相关配置信息！",
			})
			return
		}
	case "TurnstileCheckEnabled":
		if option.Value == "true" && common.TurnstileSiteKey == "" {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": "无法启用 Turnstile 校验，请先填入 Turnstile 校验相关配置信息！",
			})

			return
		}
	case "TelegramOAuthEnabled":
		if option.Value == "true" && common.TelegramBotToken == "" {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": "无法启用 Telegram OAuth，请先填入 Telegram Bot Token！",
			})
			return
		}
	case "theme.frontend":
		if option.Value != "default" && option.Value != "classic" {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": "无效的主题值，可选值：default（新版前端）、classic（经典前端）",
			})
			return
		}
	case "GroupRatio":
		err = ratio_setting.CheckGroupRatio(option.Value.(string))
		if err != nil {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": err.Error(),
			})
			return
		}
	case "gemini.safety_settings":
		err = model_setting.ValidateGeminiSafetySettings(option.Value.(string))
		if err != nil {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": err.Error(),
			})
			return
		}
	case "claude.default_max_tokens":
		err = model_setting.ValidateClaudeDefaultMaxTokens(option.Value.(string))
		if err != nil {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": err.Error(),
			})
			return
		}
	case operation_setting.ToolPriceOptionKey:
		err = operation_setting.ValidateToolPricesJSON(option.Value.(string))
		if err != nil {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": err.Error(),
			})
			return
		}
	case "ImageRatio":
		err = ratio_setting.UpdateImageRatioByJSONString(option.Value.(string))
		if err != nil {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": "图片倍率设置失败: " + err.Error(),
			})
			return
		}
	case "AudioRatio":
		err = ratio_setting.UpdateAudioRatioByJSONString(option.Value.(string))
		if err != nil {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": "音频倍率设置失败: " + err.Error(),
			})
			return
		}
	case "AudioCompletionRatio":
		err = ratio_setting.UpdateAudioCompletionRatioByJSONString(option.Value.(string))
		if err != nil {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": "音频补全倍率设置失败: " + err.Error(),
			})
			return
		}
	case "ModelRequestRateLimitGroup":
		err = setting.CheckModelRequestRateLimitGroup(option.Value.(string))
		if err != nil {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": err.Error(),
			})
			return
		}
	case "AutomaticDisableStatusCodes":
		_, err = operation_setting.ParseHTTPStatusCodeRanges(option.Value.(string))
		if err != nil {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": err.Error(),
			})
			return
		}
	case "AutomaticRetryStatusCodes":
		_, err = operation_setting.ParseHTTPStatusCodeRanges(option.Value.(string))
		if err != nil {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": err.Error(),
			})
			return
		}
	case "console_setting.api_info":
		err = console_setting.ValidateConsoleSettings(option.Value.(string), "ApiInfo")
		if err != nil {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": err.Error(),
			})
			return
		}
	case "console_setting.announcements":
		err = console_setting.ValidateConsoleSettings(option.Value.(string), "Announcements")
		if err != nil {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": err.Error(),
			})
			return
		}
	case "console_setting.faq":
		err = console_setting.ValidateConsoleSettings(option.Value.(string), "FAQ")
		if err != nil {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": err.Error(),
			})
			return
		}
	case "console_setting.uptime_kuma_groups":
		err = console_setting.ValidateConsoleSettings(option.Value.(string), "UptimeKumaGroups")
		if err != nil {
			c.JSON(http.StatusOK, gin.H{
				"success": false,
				"message": err.Error(),
			})
			return
		}
	}
	err = model.UpdateOption(option.Key, option.Value.(string))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	// 出于安全考虑只记录被修改的配置项名称，不记录配置值（可能含密钥等敏感信息）。
	recordManageAudit(c, "option.update", map[string]interface{}{
		"key": option.Key,
	})
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
	})
}
