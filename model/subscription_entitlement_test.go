package model

import (
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/require"
)

func TestSubscriptionPlanFeatureKeysNormalizeAndMatch(t *testing.T) {
	plan := &SubscriptionPlan{FeatureKeys: " wechat_bridge, WECHAT_BRIDGE ; other-feature "}
	plan.NormalizeDefaults()

	require.Equal(t, "wechat_bridge,other-feature", plan.FeatureKeys)
	require.True(t, plan.HasFeature(SubscriptionFeatureWechatBridge))
	require.True(t, plan.HasFeature("other-feature"))
	require.False(t, plan.HasFeature("missing"))
}

func TestHasActiveUserSubscriptionFeatureRequiresPlanFeature(t *testing.T) {
	truncateTables(t)

	insertUserForPaymentGuardTest(t, 711, 0)
	now := common.GetTimestamp()

	plainPlan := &SubscriptionPlan{
		Id:            7111,
		Title:         "Plain",
		PriceAmount:   9.9,
		Currency:      "USD",
		DurationUnit:  SubscriptionDurationMonth,
		DurationValue: 1,
		Enabled:       true,
	}
	require.NoError(t, DB.Create(plainPlan).Error)
	require.NoError(t, DB.Create(&UserSubscription{
		UserId:    711,
		PlanId:    plainPlan.Id,
		StartTime: now - 60,
		EndTime:   now + 3600,
		Status:    "active",
		Source:    "test",
	}).Error)

	has, err := HasActiveUserSubscriptionFeature(711, SubscriptionFeatureWechatBridge)
	require.NoError(t, err)
	require.False(t, has)

	wechatPlan := &SubscriptionPlan{
		Id:            7112,
		Title:         "WeChat",
		PriceAmount:   19.9,
		Currency:      "USD",
		DurationUnit:  SubscriptionDurationMonth,
		DurationValue: 1,
		Enabled:       true,
		FeatureKeys:   SubscriptionFeatureWechatBridge,
	}
	require.NoError(t, DB.Create(wechatPlan).Error)
	require.NoError(t, DB.Create(&UserSubscription{
		UserId:    711,
		PlanId:    wechatPlan.Id,
		StartTime: now - 60,
		EndTime:   now + 7200,
		Status:    "active",
		Source:    "test",
	}).Error)

	has, err = HasActiveUserSubscriptionFeature(711, SubscriptionFeatureWechatBridge)
	require.NoError(t, err)
	require.True(t, has)
}

func TestCompleteManualSubscriptionOrderActivatesFeature(t *testing.T) {
	truncateTables(t)

	insertUserForPaymentGuardTest(t, 812, 0)
	plan := &SubscriptionPlan{
		Id:            8121,
		Title:         "WeChat Pro",
		PriceAmount:   29.9,
		Currency:      "USD",
		DurationUnit:  SubscriptionDurationDay,
		DurationValue: 7,
		Enabled:       true,
		FeatureKeys:   SubscriptionFeatureWechatBridge,
	}
	require.NoError(t, DB.Create(plan).Error)
	require.NoError(t, (&SubscriptionOrder{
		UserId:          812,
		PlanId:          plan.Id,
		Money:           plan.PriceAmount,
		TradeNo:         "SUBMAN812",
		PaymentMethod:   PaymentMethodManualWechat,
		PaymentProvider: PaymentProviderManualSubscription,
		Status:          common.TopUpStatusPending,
		CreateTime:      time.Now().Unix(),
	}).Insert())

	require.NoError(t, CompleteSubscriptionOrder("SUBMAN812", "approved", PaymentProviderManualSubscription, PaymentMethodManualWechat))

	has, err := HasActiveUserSubscriptionFeature(812, SubscriptionFeatureWechatBridge)
	require.NoError(t, err)
	require.True(t, has)
}
