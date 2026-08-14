package ratio_setting

import (
	"errors"
	"runtime"
	"testing"

	"github.com/QuantumNous/new-api/setting/billing_setting"
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestModelPricingSnapshotWaitsForCompleteUpdate(t *testing.T) {
	previousMaxProcs := runtime.GOMAXPROCS(1)
	t.Cleanup(func() { runtime.GOMAXPROCS(previousMaxProcs) })
	originalModelRatio := ModelRatio2JSONString()
	originalCompletionRatio := CompletionRatio2JSONString()
	t.Cleanup(func() {
		require.NoError(t, UpdateModelRatioByJSONString(originalModelRatio))
		require.NoError(t, UpdateCompletionRatioByJSONString(originalCompletionRatio))
	})
	require.NoError(t, UpdateModelRatioByJSONString(`{"snapshot-model":1}`))
	require.NoError(t, UpdateCompletionRatioByJSONString(`{"snapshot-model":2}`))

	firstMapUpdated := make(chan struct{})
	finishUpdate := make(chan struct{})
	writerDone := make(chan error, 1)
	go func() {
		writerDone <- WritePricingSnapshot(func() error {
			if err := UpdateModelRatioByJSONString(`{"snapshot-model":3}`); err != nil {
				return err
			}
			close(firstMapUpdated)
			<-finishUpdate
			return UpdateCompletionRatioByJSONString(`{"snapshot-model":4}`)
		})
	}()
	<-firstMapUpdated

	readerStarted := make(chan struct{})
	readResult := make(chan ModelPricingSnapshot, 1)
	go func() {
		close(readerStarted)
		readResult <- GetModelPricingSnapshot("snapshot-model")
	}()
	<-readerStarted
	runtime.Gosched()
	select {
	case <-readResult:
		t.Fatal("pricing reader observed an update before all maps were published")
	default:
	}

	close(finishUpdate)
	require.NoError(t, <-writerDone)
	snapshot := <-readResult
	assert.Equal(t, 3.0, snapshot.ModelRatio)
	assert.Equal(t, 4.0, snapshot.CompletionRatio)
}

func TestModelPricingSnapshotPublishesBillingConfigurationWithRatios(t *testing.T) {
	previousMaxProcs := runtime.GOMAXPROCS(1)
	t.Cleanup(func() { runtime.GOMAXPROCS(previousMaxProcs) })
	originalModelRatio := ModelRatio2JSONString()
	originalCompletionRatio := CompletionRatio2JSONString()
	originalConfig := map[string]string{}
	require.NoError(t, config.GlobalConfig.SaveToDB(func(key, value string) error {
		originalConfig[key] = value
		return nil
	}))
	t.Cleanup(func() {
		require.NoError(t, UpdateModelRatioByJSONString(originalModelRatio))
		require.NoError(t, UpdateCompletionRatioByJSONString(originalCompletionRatio))
		require.NoError(t, config.GlobalConfig.LoadFromDB(originalConfig))
	})
	require.NoError(t, UpdateModelRatioByJSONString(`{"generation-model":1}`))
	require.NoError(t, UpdateCompletionRatioByJSONString(`{"generation-model":2}`))
	require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{
		"billing_setting.billing_mode": `{}`,
		"billing_setting.billing_expr": `{}`,
	}))
	initialGeneration := GetModelPricingSnapshot("generation-model").Generation

	pricingUpdated := make(chan struct{})
	finishUpdate := make(chan struct{})
	writerDone := make(chan error, 1)
	go func() {
		writerDone <- WritePricingSnapshot(func() error {
			if err := UpdateModelRatioByJSONString(`{"generation-model":3}`); err != nil {
				return err
			}
			if err := config.GlobalConfig.LoadFromDB(map[string]string{
				"billing_setting.billing_mode": `{"generation-model":"tiered_expr"}`,
				"billing_setting.billing_expr": `{"generation-model":"tier(\"new\", p * 3)"}`,
			}); err != nil {
				return err
			}
			close(pricingUpdated)
			<-finishUpdate
			return UpdateCompletionRatioByJSONString(`{"generation-model":4}`)
		})
	}()
	<-pricingUpdated

	readResult := make(chan ModelPricingSnapshot, 1)
	go func() { readResult <- GetModelPricingSnapshot("generation-model") }()
	runtime.Gosched()
	select {
	case <-readResult:
		t.Fatal("pricing reader observed billing configuration before the generation committed")
	default:
	}

	close(finishUpdate)
	require.NoError(t, <-writerDone)
	snapshot := <-readResult
	assert.Equal(t, initialGeneration+1, snapshot.Generation)
	assert.Equal(t, 3.0, snapshot.ModelRatio)
	assert.Equal(t, 4.0, snapshot.CompletionRatio)
	assert.Equal(t, billing_setting.BillingModeTieredExpr, snapshot.BillingMode)
	assert.Equal(t, `tier("new", p * 3)`, snapshot.BillingExpr)
	assert.True(t, snapshot.BillingExprFound)
}

func TestRuntimePricingSyncDataUsesTheBillingSnapshot(t *testing.T) {
	originalModelRatio := ModelRatio2JSONString()
	originalConfig := map[string]string{}
	require.NoError(t, config.GlobalConfig.SaveToDB(func(key, value string) error {
		originalConfig[key] = value
		return nil
	}))
	t.Cleanup(func() {
		require.NoError(t, UpdateModelRatioByJSONString(originalModelRatio))
		require.NoError(t, config.GlobalConfig.LoadFromDB(originalConfig))
	})
	require.NoError(t, UpdateModelRatioByJSONString(`{"sync-model":7}`))
	require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{
		"billing_setting.billing_mode": `{"sync-model":"tiered_expr"}`,
		"billing_setting.billing_expr": `{"sync-model":"tier(\"sync\", p * 7)"}`,
	}))

	data := GetRuntimePricingSyncData()
	assert.Equal(t, 7.0, data["model_ratio"].(map[string]float64)["sync-model"])
	assert.Equal(t, billing_setting.BillingModeTieredExpr,
		data[billing_setting.BillingModeField].(map[string]string)["sync-model"])
	assert.Equal(t, `tier("sync", p * 7)`,
		data[billing_setting.BillingExprField].(map[string]string)["sync-model"])
}

func TestFailedPricingSnapshotWriteDoesNotPublishGeneration(t *testing.T) {
	before := GetModelPricingSnapshot("failed-generation-model").Generation
	expected := errors.New("injected snapshot failure")

	err := WritePricingSnapshot(func() error { return expected })

	require.ErrorIs(t, err, expected)
	after := GetModelPricingSnapshot("failed-generation-model").Generation
	assert.Equal(t, before, after)
}

func TestExposedPricingDataWaitsForCompleteUpdate(t *testing.T) {
	previousMaxProcs := runtime.GOMAXPROCS(1)
	t.Cleanup(func() { runtime.GOMAXPROCS(previousMaxProcs) })
	originalModelRatio := ModelRatio2JSONString()
	originalCompletionRatio := CompletionRatio2JSONString()
	t.Cleanup(func() {
		require.NoError(t, UpdateModelRatioByJSONString(originalModelRatio))
		require.NoError(t, UpdateCompletionRatioByJSONString(originalCompletionRatio))
	})
	require.NoError(t, UpdateModelRatioByJSONString(`{"snapshot-model":1}`))
	require.NoError(t, UpdateCompletionRatioByJSONString(`{"snapshot-model":2}`))
	InvalidateExposedDataCache()

	firstMapUpdated := make(chan struct{})
	finishUpdate := make(chan struct{})
	writerDone := make(chan error, 1)
	go func() {
		writerDone <- WritePricingSnapshot(func() error {
			if err := UpdateModelRatioByJSONString(`{"snapshot-model":3}`); err != nil {
				return err
			}
			close(firstMapUpdated)
			<-finishUpdate
			return UpdateCompletionRatioByJSONString(`{"snapshot-model":4}`)
		})
	}()
	<-firstMapUpdated

	readerStarted := make(chan struct{})
	readResult := make(chan map[string]any, 1)
	go func() {
		close(readerStarted)
		readResult <- GetExposedData()
	}()
	<-readerStarted
	runtime.Gosched()
	select {
	case <-readResult:
		t.Fatal("exposed pricing cache observed an update before all maps were published")
	default:
	}

	close(finishUpdate)
	require.NoError(t, <-writerDone)
	data := <-readResult
	modelRatios := data["model_ratio"].(map[string]float64)
	completionRatios := data["completion_ratio"].(map[string]float64)
	assert.Equal(t, 3.0, modelRatios["snapshot-model"])
	assert.Equal(t, 4.0, completionRatios["snapshot-model"])
}
