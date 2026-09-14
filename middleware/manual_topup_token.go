package middleware

import (
	"errors"
	"net"
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// TokenManualTopUpAuth must follow TokenAuthReadOnly. It revalidates its
// identity against current database state, without requiring spendable quota.
func TokenManualTopUpAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		tokenID, ownerID, key := c.GetInt("token_id"), c.GetInt("id"), c.GetString("token_key")
		if tokenID <= 0 || ownerID <= 0 || key == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"success": false, "message": common.TranslateMessage(c, i18n.MsgTokenInvalid)})
			return
		}
		var token model.Token
		err := model.DB.First(&token, "id = ?", tokenID).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"success": false, "message": common.TranslateMessage(c, i18n.MsgDatabaseError)})
			return
		}
		if err != nil || token.Key != key || token.UserId != ownerID ||
			(token.Status != common.TokenStatusEnabled && token.Status != common.TokenStatusExhausted) ||
			(token.ExpiredTime != -1 && token.ExpiredTime <= common.GetTimestamp()) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"success": false, "message": common.TranslateMessage(c, i18n.MsgTokenInvalid)})
			return
		}
		var owner model.User
		err = model.DB.Select("id", "status").First(&owner, "id = ?", token.UserId).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"success": false, "message": common.TranslateMessage(c, i18n.MsgDatabaseError)})
			return
		}
		if err != nil || owner.Status != common.UserStatusEnabled {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "message": common.TranslateMessage(c, i18n.MsgAuthUserBanned)})
			return
		}
		if allowedIPs := token.GetIpLimits(); len(allowedIPs) > 0 {
			ip := net.ParseIP(c.ClientIP())
			if ip == nil || !common.IsIpInCIDRList(ip, allowedIPs) {
				c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "message": "您的 IP 不在令牌允许访问的列表中"})
				return
			}
		}
		c.Set("id", owner.Id)
		c.Next()
	}
}

// ManualTopUpWriteRateLimit shares the existing critical-rate configuration,
// but keys requests by owner rather than token or IP. Use only on write routes,
// after TokenManualTopUpAuth, so history reads do not consume this allowance.
func ManualTopUpWriteRateLimit() gin.HandlerFunc {
	return UserCriticalRateLimit("manual-topup")
}
