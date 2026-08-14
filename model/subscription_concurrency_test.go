package model

import (
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAdminBindSubscriptionConcurrentPurchaseLimitAllowsOnlyOne(t *testing.T) {
	truncateTables(t)

	const userID = 9701
	insertUserForPaymentGuardTest(t, userID, 0)
	plan := &SubscriptionPlan{
		Id:                 9702,
		Title:              "Single Purchase",
		PriceAmount:        9.99,
		Currency:           "USD",
		DurationUnit:       SubscriptionDurationMonth,
		DurationValue:      1,
		Enabled:            true,
		MaxPurchasePerUser: 1,
		TotalAmount:        1000,
	}
	require.NoError(t, DB.Create(plan).Error)

	start := make(chan struct{})
	var wg sync.WaitGroup
	var results [2]error
	for i := range results {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			_, results[index] = AdminBindSubscription(userID, plan.Id, "concurrency test")
		}(i)
	}
	close(start)
	wg.Wait()

	successes := 0
	limitErrors := 0
	for _, err := range results {
		if err == nil {
			successes++
		} else if err.Error() == "已达到该套餐购买上限" {
			limitErrors++
		}
	}
	assert.Equal(t, 1, successes)
	assert.Equal(t, 1, limitErrors)
	assert.EqualValues(t, 1, countUserSubscriptionsForPaymentGuardTest(t, userID))
}
