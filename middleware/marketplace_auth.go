package middleware

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// UserOrMarketplaceAuth accepts a normal dashboard session or a model-site key.
// Marketplace key access is independent from model quota: an exhausted key may
// still download account-entitled plugins, while disabled/expired keys fail.
func UserOrMarketplaceAuth() func(c *gin.Context) {
	return func(c *gin.Context) {
		authorization := c.GetHeader("Authorization")
		if strings.HasPrefix(authorization, "Bearer ") || strings.HasPrefix(authorization, "bearer ") {
			MarketplaceTokenAuth()(c)
			return
		}
		UserAuth()(c)
	}
}

func MarketplaceTokenAuth() func(c *gin.Context) {
	return func(c *gin.Context) {
		key := strings.TrimSpace(c.GetHeader("Authorization"))
		if key == "" {
			marketplaceAuthError(c, http.StatusUnauthorized, "未提供模型站令牌")
			return
		}
		if strings.HasPrefix(key, "Bearer ") || strings.HasPrefix(key, "bearer ") {
			key = strings.TrimSpace(key[7:])
		}
		key = strings.TrimPrefix(key, "sk-")
		key = strings.Split(key, "-")[0]
		token, err := model.GetTokenByKey(key, false)
		if err != nil {
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				common.SysLog("MarketplaceTokenAuth GetTokenByKey database error: " + err.Error())
				marketplaceAuthError(c, http.StatusInternalServerError, "数据库错误")
				return
			}
			marketplaceAuthError(c, http.StatusUnauthorized, "模型站令牌无效")
			return
		}
		if token.Status != common.TokenStatusEnabled && token.Status != common.TokenStatusExhausted {
			marketplaceAuthError(c, http.StatusUnauthorized, "模型站令牌已停用或过期")
			return
		}
		if token.ExpiredTime != -1 && token.ExpiredTime < common.GetTimestamp() {
			marketplaceAuthError(c, http.StatusUnauthorized, "模型站令牌已过期")
			return
		}
		allowIPs := token.GetIpLimits()
		if len(allowIPs) > 0 {
			ip := net.ParseIP(c.ClientIP())
			if ip == nil || !common.IsIpInCIDRList(ip, allowIPs) {
				marketplaceAuthError(c, http.StatusForbidden, "客户端 IP 不在令牌允许列表")
				return
			}
		}
		user, err := model.GetUserCache(token.UserId)
		if err != nil {
			common.SysLog(fmt.Sprintf("MarketplaceTokenAuth GetUserCache error for user %d: %v", token.UserId, err))
			marketplaceAuthError(c, http.StatusInternalServerError, "数据库错误")
			return
		}
		if user.Status != common.UserStatusEnabled {
			marketplaceAuthError(c, http.StatusForbidden, "用户已停用")
			return
		}
		c.Set("id", token.UserId)
		c.Set("token_id", token.Id)
		c.Set("token_key", token.Key)
		c.Next()
	}
}

func marketplaceAuthError(c *gin.Context, status int, message string) {
	c.JSON(status, gin.H{"success": false, "message": message})
	c.Abort()
}
