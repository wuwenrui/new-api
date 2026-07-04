package common

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// 计费不变量：订阅仅解锁功能，消费一律走钱包余额，订阅永不作为扣费来源。
// 任何历史 / 非法计费偏好都必须归一到 wallet_only，杜绝功能型订阅
// （plan.total_amount=0 语义为“不限量”）被当成无限额度池白嫖。
func TestNormalizeBillingPreferenceAlwaysWalletOnly(t *testing.T) {
	cases := []string{
		"",
		"subscription_first",
		"subscription_only",
		"wallet_first",
		"wallet_only",
		"  subscription_first  ",
		"unexpected_value",
	}
	for _, in := range cases {
		assert.Equal(t, "wallet_only", NormalizeBillingPreference(in),
			"billing preference %q must resolve to wallet_only", in)
	}
}
