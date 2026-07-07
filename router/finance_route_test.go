package router

import (
	"os"
	"strings"
	"testing"
)

func TestFinanceReportRouteUsesAdminAuth(t *testing.T) {
	source, err := os.ReadFile("api-router.go")
	if err != nil {
		t.Fatalf("read api-router.go: %v", err)
	}

	text := string(source)
	if !strings.Contains(text, "financeRoute.Use(middleware.AdminAuth())") {
		t.Fatalf("finance report route should use AdminAuth")
	}
	if strings.Contains(text, "financeRoute.Use(middleware.RootAuth())") {
		t.Fatalf("finance report route should not be limited to RootAuth")
	}
}

func TestPACPriceMonitorRouteUsesFinanceAdminAuth(t *testing.T) {
	source, err := os.ReadFile("api-router.go")
	if err != nil {
		t.Fatalf("read api-router.go: %v", err)
	}

	text := string(source)
	if !strings.Contains(text, `financeRoute.GET("/pac-price-monitor", controller.GetPACPriceMonitorReport)`) {
		t.Fatalf("PAC price monitor route should be mounted under finance admin routes")
	}
	if !strings.Contains(text, "financeRoute.Use(middleware.AdminAuth())") {
		t.Fatalf("PAC price monitor route should use AdminAuth")
	}
}
