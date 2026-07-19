package operation_setting

import "github.com/QuantumNous/new-api/setting/config"

const (
	SubscriptionFeaturePolicySubscription = "subscription"
	SubscriptionFeaturePolicyFree         = "free"
)

type SubscriptionFeatureSetting struct {
	// AccessPolicies maps a subscription feature key to its access policy.
	// "free" opens the feature to every authenticated user; any other value
	// (default "subscription") requires an active subscription whose plan
	// contains the feature key.
	AccessPolicies map[string]string `json:"access_policies"`
}

var subscriptionFeatureSetting = SubscriptionFeatureSetting{
	AccessPolicies: map[string]string{},
}

func init() {
	config.GlobalConfig.Register("subscription_feature_setting", &subscriptionFeatureSetting)
}

func GetSubscriptionFeatureSetting() *SubscriptionFeatureSetting {
	return &subscriptionFeatureSetting
}

func IsSubscriptionFeatureFree(featureKey string) bool {
	return subscriptionFeatureSetting.AccessPolicies[featureKey] == SubscriptionFeaturePolicyFree
}
