package ratio_setting

import (
	"sync"

	"github.com/QuantumNous/new-api/setting/billing_setting"
)

var pricingSnapshotMutex sync.RWMutex
var pricingSnapshotGeneration uint64

// ReadPricingSnapshot keeps related pricing maps stable for the duration of read.
func ReadPricingSnapshot(read func()) {
	pricingSnapshotMutex.RLock()
	defer pricingSnapshotMutex.RUnlock()
	read()
}

// WritePricingSnapshot prevents billing readers from observing a partial pricing update.
func WritePricingSnapshot(update func() error) error {
	pricingSnapshotMutex.Lock()
	defer pricingSnapshotMutex.Unlock()
	if err := update(); err != nil {
		return err
	}
	pricingSnapshotGeneration++
	return nil
}

type ModelPricingSnapshot struct {
	Generation       uint64
	ModelPrice       float64
	UsesFixedPrice   bool
	ModelPriceKey    string
	ModelRatio       float64
	ModelRatioFound  bool
	ModelRatioKey    string
	CompletionRatio  float64
	CacheRatio       float64
	CreateCacheRatio float64
	BillingMode      string
	BillingExpr      string
	BillingExprFound bool
}

func GetModelPricingSnapshot(modelName string) ModelPricingSnapshot {
	var snapshot ModelPricingSnapshot
	ReadPricingSnapshot(func() {
		snapshot.Generation = pricingSnapshotGeneration
		snapshot.ModelPrice, snapshot.UsesFixedPrice, snapshot.ModelPriceKey = GetModelPriceInfo(modelName, false)
		snapshot.ModelRatio, snapshot.ModelRatioFound, snapshot.ModelRatioKey = GetModelRatio(modelName)
		snapshot.CompletionRatio = GetCompletionRatio(modelName)
		snapshot.CacheRatio, _ = GetCacheRatio(modelName)
		snapshot.CreateCacheRatio, _ = GetCreateCacheRatio(modelName)
		snapshot.BillingMode = billing_setting.GetBillingMode(modelName)
		snapshot.BillingExpr, snapshot.BillingExprFound = billing_setting.GetBillingExpr(modelName)
	})
	return snapshot
}

func GetRuntimePricingSyncData() map[string]any {
	var snapshot map[string]any
	ReadPricingSnapshot(func() {
		snapshot = billing_setting.GetPricingSyncData(map[string]any{
			"model_ratio":          GetModelRatioCopy(),
			"completion_ratio":     GetCompletionRatioCopy(),
			"cache_ratio":          GetCacheRatioCopy(),
			"create_cache_ratio":   GetCreateCacheRatioCopy(),
			"model_price":          GetModelPriceCopy(),
			"model_original_price": GetModelOriginalPriceCopy(),
		})
	})
	return snapshot
}
