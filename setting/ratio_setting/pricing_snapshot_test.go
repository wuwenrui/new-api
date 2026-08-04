package ratio_setting

import (
	"runtime"
	"testing"

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
