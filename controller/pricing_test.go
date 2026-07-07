package controller

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type pricingResponse struct {
	Success bool            `json:"success"`
	Data    []model.Pricing `json:"data"`
}

func decodePricingResponse(t *testing.T, recorder *httptest.ResponseRecorder) pricingResponse {
	t.Helper()

	require.Equal(t, http.StatusOK, recorder.Code)
	var payload pricingResponse
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &payload))
	require.True(t, payload.Success)
	return payload
}

func seedPricingChannelFilterData(t *testing.T) {
	t.Helper()

	db := setupModelListControllerTestDB(t)
	require.NoError(t, db.Create(&[]model.User{
		{
			Id:       2101,
			Username: "pricing-common-user",
			Password: "password",
			Group:    "default",
			Status:   common.UserStatusEnabled,
			Role:     common.RoleCommonUser,
			AffCode:  "pricing_common",
		},
		{
			Id:       2102,
			Username: "pricing-admin-user",
			Password: "password",
			Group:    "default",
			Status:   common.UserStatusEnabled,
			Role:     common.RoleAdminUser,
			AffCode:  "pricing_admin",
		},
	}).Error)
	require.NoError(t, db.Create(&[]model.Channel{
		{Id: 3101, Name: "primary-openai", Type: 1, Key: "test-key", Status: 1},
		{Id: 3102, Name: "backup-openai", Type: 1, Key: "test-key", Status: 1},
	}).Error)
	priorityHigh := int64(10)
	priorityLow := int64(0)
	require.NoError(t, db.Create(&[]model.Ability{
		{Group: "default", Model: "zz-channel-filter-model", ChannelId: 3101, Enabled: true, Priority: &priorityHigh},
		{Group: "default", Model: "zz-channel-filter-model", ChannelId: 3102, Enabled: true, Priority: &priorityLow},
	}).Error)
	model.InvalidatePricingCache()
}

func callPricing(t *testing.T, userId int, role int) pricingResponse {
	t.Helper()

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/pricing", nil)
	ctx.Set("id", userId)
	ctx.Set("role", role)

	GetPricing(ctx)
	return decodePricingResponse(t, recorder)
}

func TestGetPricingHidesChannelsFromNonAdmin(t *testing.T) {
	seedPricingChannelFilterData(t)

	payload := callPricing(t, 2101, common.RoleCommonUser)

	byName := pricingByModelName(payload.Data)
	pricing, ok := byName["zz-channel-filter-model"]
	require.True(t, ok)
	require.Empty(t, pricing.Channels)
}

func TestGetPricingIncludesChannelsForAdmin(t *testing.T) {
	seedPricingChannelFilterData(t)

	payload := callPricing(t, 2102, common.RoleAdminUser)

	byName := pricingByModelName(payload.Data)
	pricing, ok := byName["zz-channel-filter-model"]
	require.True(t, ok)
	require.ElementsMatch(t, []model.PricingChannel{
		{ID: 3101, Name: "primary-openai", Type: 1, Priority: 10},
		{ID: 3102, Name: "backup-openai", Type: 1, Priority: 0},
	}, pricing.Channels)
}
