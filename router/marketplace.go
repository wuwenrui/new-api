package router

import (
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

func registerMarketplaceRoutes(apiRouter *gin.RouterGroup) {
	marketplaceRoute := apiRouter.Group("/marketplace")
	marketplaceRoute.Use(middleware.UserOrMarketplaceAuth())
	{
		marketplaceRoute.GET("/catalog", controller.GetMarketplaceCatalog)
		marketplaceRoute.GET("/plugins/:id/versions/:version/download", controller.DownloadMarketplacePlugin)
	}

	marketplaceAdminRoute := apiRouter.Group("/marketplace/admin")
	marketplaceAdminRoute.Use(middleware.AdminAuth())
	{
		marketplaceAdminRoute.POST("/plugins", controller.AdminPublishMarketplacePlugin)
		marketplaceAdminRoute.DELETE("/plugins/:id", controller.AdminDeleteMarketplacePlugin)
	}
}
