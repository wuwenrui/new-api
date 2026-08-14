package model

import (
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/setting/billing_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRefreshPricingWaitsForRuntimePricingPublication(t *testing.T) {
	setupPricingRefreshSnapshotTest(t)

	common.OptionMapRWMutex.Lock()
	optionMapLocked := true
	defer func() {
		if optionMapLocked {
			common.OptionMapRWMutex.Unlock()
		}
	}()

	updateDone := make(chan error, 1)
	go func() {
		updateDone <- UpdateOptionsBulk(runtimePricingGeneration(true))
	}()
	waitForPersistedPricingOption(t, "ModelPrice", `{"runtime-model":0.25}`)

	refreshDone := make(chan struct{})
	go func() {
		RefreshPricing()
		close(refreshDone)
	}()

	select {
	case <-refreshDone:
		common.OptionMapRWMutex.Unlock()
		optionMapLocked = false
		require.NoError(t, <-updateDone)
		t.Fatal("RefreshPricing completed while runtime pricing publication was incomplete")
	case <-time.After(100 * time.Millisecond):
	}

	common.OptionMapRWMutex.Unlock()
	optionMapLocked = false
	require.NoError(t, <-updateDone)
	select {
	case <-refreshDone:
	case <-time.After(5 * time.Second):
		t.Fatal("RefreshPricing deadlocked after runtime pricing publication completed")
	}

	RefreshPricing()
	pricing := findPricingByModel(GetPricing(), "runtime-model")
	require.NotNil(t, pricing)
	assert.Equal(t, 0.25, pricing.ModelPrice)
	assert.Equal(t, 1, pricing.QuotaType)
	assert.Equal(t, billing_setting.BillingModeTieredExpr, pricing.BillingMode)
	assert.Equal(t, `tier("long", p * 3)`, pricing.BillingExpr)
}

func setupPricingRefreshSnapshotTest(t *testing.T) {
	t.Helper()
	setupOptionSyncTestDB(t)
	preserveRuntimePricingState(t)
	require.NoError(t, DB.AutoMigrate(&Channel{}, &Ability{}, &Model{}, &Vendor{}))
	require.NoError(t, DB.Create(&Channel{
		Id: 901, Type: constant.ChannelTypeOpenAI, Key: "pricing-refresh-test-key",
		Status: common.ChannelStatusEnabled, Name: "pricing-refresh-test-channel",
	}).Error)
	require.NoError(t, DB.Create(&Ability{
		Group: "default", Model: "runtime-model", ChannelId: 901, Enabled: true,
	}).Error)
	require.NoError(t, DB.Create(&Model{
		ModelName: "runtime-model", Status: 1, NameRule: NameRuleExact,
	}).Error)
	require.NoError(t, UpdateOptionsBulk(runtimePricingGeneration(false)))
	RefreshPricing()
}

func waitForPersistedPricingOption(t *testing.T, key string, value string) {
	t.Helper()
	require.Eventually(t, func() bool {
		var option Option
		err := DB.Where("key = ?", key).First(&option).Error
		return err == nil && option.Value == value
	}, 5*time.Second, time.Millisecond)
}

func findPricingByModel(pricings []Pricing, modelName string) *Pricing {
	for index := range pricings {
		if pricings[index].ModelName == modelName {
			return &pricings[index]
		}
	}
	return nil
}
