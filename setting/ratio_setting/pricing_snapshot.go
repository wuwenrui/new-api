package ratio_setting

import "sync"

var pricingSnapshotMutex sync.RWMutex

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
	return update()
}

type ModelPricingSnapshot struct {
	ModelPrice       float64
	UsesFixedPrice   bool
	ModelPriceKey    string
	ModelRatio       float64
	ModelRatioFound  bool
	ModelRatioKey    string
	CompletionRatio  float64
	CacheRatio       float64
	CreateCacheRatio float64
}

func GetModelPricingSnapshot(modelName string) ModelPricingSnapshot {
	var snapshot ModelPricingSnapshot
	ReadPricingSnapshot(func() {
		snapshot.ModelPrice, snapshot.UsesFixedPrice, snapshot.ModelPriceKey = GetModelPriceInfo(modelName, false)
		snapshot.ModelRatio, snapshot.ModelRatioFound, snapshot.ModelRatioKey = GetModelRatio(modelName)
		snapshot.CompletionRatio = GetCompletionRatio(modelName)
		snapshot.CacheRatio, _ = GetCacheRatio(modelName)
		snapshot.CreateCacheRatio, _ = GetCreateCacheRatio(modelName)
	})
	return snapshot
}
