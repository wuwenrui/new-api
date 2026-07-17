package router

import (
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

func SetWeChatOfficialAccountRouter(router *gin.Engine) {
	wechatRouter := router.Group("/v1/wechat-official-account")
	wechatRouter.Use(middleware.RouteTag("relay"))
	wechatRouter.Use(middleware.TokenAuth())
	wechatRouter.Use(middleware.CriticalRateLimit())
	{
		wechatRouter.GET("/public-key", controller.GetWeChatOfficialAccountRelayPublicKey)
		wechatRouter.POST("/relay", controller.RelayWeChatOfficialAccount)
	}
}
