package service

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/setting/ratio_setting"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupPriceCompareRatios(t *testing.T) {
	t.Helper()
	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"test-model":5}`))
	require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(`{"test-model":5}`))
	require.NoError(t, ratio_setting.UpdateCacheRatioByJSONString(`{"test-model":0.1}`))
	require.NoError(t, ratio_setting.UpdateCreateCacheRatioByJSONString(`{"test-model":1.25}`))
}

func channelPriceValue(value float64) *float64 {
	return &value
}

func newPriceCompareChannel() *model.Channel {
	priority := int64(100)
	return &model.Channel{Id: 7, Name: "coderelay-test", Priority: &priority}
}

func snapshotWithTestModel() upstreamPricingSnapshot {
	return upstreamPricingSnapshot{
		GroupRatios: map[string]float64{"grp": 0.3},
		Models: map[string]upstreamPricingModel{
			"test-model": {ModelRatio: 5, CompletionRatio: 5, CacheRatio: 0.1, CreateCacheRatio: 1.25},
		},
	}
}

func newOfficialPriceCompareChannel() *model.Channel {
	channel := newPriceCompareChannel()
	channel.SetOtherSettings(dto.ChannelOtherSettings{
		UpstreamPricingSource: dto.UpstreamPricingSourceModelsDev,
		ModelPrices: map[string]dto.ChannelModelPrice{
			"test-model": {
				Input:      channelPriceValue(9),
				Output:     channelPriceValue(45),
				CacheRead:  channelPriceValue(0.9),
				CacheWrite: channelPriceValue(11.25),
				Source:     dto.UpstreamPricingSourceModelsDev,
				Provider:   "openai",
			},
		},
	})
	return channel
}

// 本地分组倍率 2.5，上游分组倍率 0.3，模型倍率两侧一致：
// 本地 输入25/输出125/缓存读2.5/缓存写31.25；上游 输入3/输出15/缓存读0.3/缓存写3.75；盈利率均 88%。
func TestBuildChannelPriceCompareRowOK(t *testing.T) {
	setupPriceCompareRatios(t)
	row := buildChannelPriceCompareRow(newPriceCompareChannel(), "grp", "test-model", snapshotWithTestModel(), 2.5)

	assert.Equal(t, "ok", row.Status)
	assert.Equal(t, int64(100), row.Priority)
	assert.Equal(t, "grp", row.UpstreamGroup)

	assert.InDelta(t, 25.0, row.LocalInput, 1e-9)
	assert.InDelta(t, 125.0, row.LocalOutput, 1e-9)
	assert.InDelta(t, 2.5, row.LocalCacheRead, 1e-9)
	assert.InDelta(t, 31.25, row.LocalCacheWrite, 1e-9)

	assert.InDelta(t, 3.0, row.UpstreamInput, 1e-9)
	assert.InDelta(t, 15.0, row.UpstreamOutput, 1e-9)
	assert.InDelta(t, 0.3, row.UpstreamCacheRead, 1e-9)
	assert.InDelta(t, 3.75, row.UpstreamCacheWrite, 1e-9)

	assert.InDelta(t, 88.0, row.MarginInput, 1e-9)
	assert.InDelta(t, 88.0, row.MarginOutput, 1e-9)
}

func TestBuildChannelPriceCompareRowExposesNormalizedUpstreamPriceMultiplier(t *testing.T) {
	setupPriceCompareRatios(t)

	// New wizard-created NewAPI channels carry an explicit false marker even
	// though their relay protocol type is OpenAI/Anthropic.
	explicitNewAPIChannel := newPriceCompareChannel()
	explicitNewAPIChannel.Type = constant.ChannelTypeOpenAI
	explicitNewAPISettings := explicitNewAPIChannel.GetOtherSettings()
	explicitNewAPISettings.UpstreamPricingSource = "newapi"
	explicitNewAPIChannel.SetOtherSettings(explicitNewAPISettings)
	row := buildChannelPriceCompareRow(explicitNewAPIChannel, "grp", "test-model", snapshotWithTestModel(), 1)
	require.NotNil(t, row.UsesOfficialPricing)
	assert.False(t, *row.UsesOfficialPricing)

	// The Sub2API wizard persists the Models.dev source and multiplier while
	// retaining the OpenAI/Anthropic relay protocol type.
	onboardedSub2APIChannel := newPriceCompareChannel()
	onboardedSub2APIChannel.Type = constant.ChannelTypeOpenAI
	multiplier := 0.25
	settings := onboardedSub2APIChannel.GetOtherSettings()
	settings.UpstreamPricingSource = "models_dev"
	settings.UpstreamPriceMultiplier = &multiplier
	onboardedSub2APIChannel.SetOtherSettings(settings)
	row = buildChannelPriceCompareRow(onboardedSub2APIChannel, "grp", "test-model", snapshotWithTestModel(), 1)
	assert.Equal(t, 0.25, row.UpstreamPriceMultiplier)
	require.NotNil(t, row.UsesOfficialPricing)
	assert.True(t, *row.UsesOfficialPricing)

	// Direct type-59 Sub2API channels are unambiguously official.
	legacySub2APIChannel := newPriceCompareChannel()
	legacySub2APIChannel.Type = constant.ChannelTypeSub2API
	row = buildChannelPriceCompareRow(legacySub2APIChannel, "grp", "test-model", snapshotWithTestModel(), 1)
	assert.Equal(t, 1.0, row.UpstreamPriceMultiplier)
	require.NotNil(t, row.UsesOfficialPricing)
	assert.True(t, *row.UsesOfficialPricing)

	// Pre-marker OpenAI/Anthropic rows are ambiguous and must preserve the old
	// frontend selection behavior rather than being mislabeled false.
	legacyWizardChannel := newPriceCompareChannel()
	legacyWizardChannel.Type = constant.ChannelTypeOpenAI
	row = buildChannelPriceCompareRow(legacyWizardChannel, "grp", "test-model", snapshotWithTestModel(), 1)
	assert.Nil(t, row.UsesOfficialPricing)
}

func TestBuildChannelPriceCompareRowUsesConfiguredQuotaScale(t *testing.T) {
	setupPriceCompareRatios(t)
	originalQuotaPerUnit := common.QuotaPerUnit
	common.QuotaPerUnit = 1_000_000
	t.Cleanup(func() {
		common.QuotaPerUnit = originalQuotaPerUnit
	})

	row := buildChannelPriceCompareRow(
		newPriceCompareChannel(),
		"grp",
		"test-model",
		snapshotWithTestModel(),
		1,
	)

	assert.InDelta(t, 5.0, row.LocalInput, 1e-9)
	assert.InDelta(t, 3.0, row.DetectedInput, 1e-9)
}

func TestBuildChannelPriceCompareRowUsesReportedUpstreamQuotaScale(t *testing.T) {
	setupPriceCompareRatios(t)
	snapshot := snapshotWithTestModel()
	snapshot.QuotaPerUnit = 1_000_000

	row := buildChannelPriceCompareRow(
		newPriceCompareChannel(),
		"grp",
		"test-model",
		snapshot,
		1,
	)

	assert.InDelta(t, 1.5, row.DetectedInput, 1e-9)
}

func TestBuildChannelPriceCompareRowUsesGroupRatioForFixedPrice(t *testing.T) {
	originalModelPrices := ratio_setting.ModelPrice2JSONString()
	t.Cleanup(func() {
		require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(originalModelPrices))
	})
	require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(`{"fixed-model":0.1}`))
	snapshot := upstreamPricingSnapshot{
		GroupRatios: map[string]float64{"grp": 1},
		Models: map[string]upstreamPricingModel{
			"fixed-model": {ModelRatio: 1, CompletionRatio: 2, CacheRatio: 0.1, CreateCacheRatio: 1},
		},
	}

	row := buildChannelPriceCompareRow(newPriceCompareChannel(), "grp", "fixed-model", snapshot, 2.5)

	assert.True(t, row.UsesFixedPrice)
	assert.InDelta(t, 0.25, row.FixedPrice, 1e-9)
	assert.NotContains(t, channelRecommendations(row), "negative_margin")
	assert.NotContains(t, channelRecommendations(row), "low_margin")
}

func TestBuildChannelPriceCompareRowManualPricePrecedesDetected(t *testing.T) {
	setupPriceCompareRatios(t)
	for _, source := range []string{"", "manual"} {
		t.Run("source="+source, func(t *testing.T) {
			channel := newPriceCompareChannel()
			channel.SetOtherSettings(dto.ChannelOtherSettings{
				UpstreamPricingSource: dto.UpstreamPricingSourceModelsDev,
				ModelPrices: map[string]dto.ChannelModelPrice{
					"test-model": {
						Input:      channelPriceValue(3),
						Output:     channelPriceValue(15),
						CacheRead:  channelPriceValue(0.3),
						CacheWrite: channelPriceValue(3.75),
						Source:     source,
					},
				},
			})

			row := buildChannelPriceCompareRow(channel, "grp", "test-model", snapshotWithTestModel(), 2.5)

			assert.Equal(t, "manual", row.PriceSource)
			assert.True(t, row.DetectedAvailable)
			assert.False(t, row.PriceChanged)
			assert.InDelta(t, 3.0, row.DetectedInput, 1e-9)
			assert.InDelta(t, 15.0, row.DetectedOutput, 1e-9)
		})
	}
}

func TestBuildChannelPriceCompareRowUsesDetectedBeforeModelsDev(t *testing.T) {
	setupPriceCompareRatios(t)
	row := buildChannelPriceCompareRow(
		newOfficialPriceCompareChannel(),
		"grp",
		"test-model",
		snapshotWithTestModel(),
		2.5,
	)

	assert.Equal(t, "ok", row.Status)
	assert.Equal(t, "detected", row.PriceSource)
	assert.True(t, row.DetectedAvailable)
	require.NotNil(t, row.UsesOfficialPricing)
	assert.True(t, *row.UsesOfficialPricing)
	assert.InDelta(t, 3.0, row.UpstreamInput, 1e-9)
	assert.InDelta(t, 15.0, row.UpstreamOutput, 1e-9)
}

func TestBuildChannelPriceCompareRowDoesNotTreatUnknownSourceAsManual(t *testing.T) {
	setupPriceCompareRatios(t)
	channel := newOfficialPriceCompareChannel()
	settings := channel.GetOtherSettings()
	storedPrice := settings.ModelPrices["test-model"]
	storedPrice.Source = dto.UpstreamPricingSourceNewAPI
	settings.ModelPrices["test-model"] = storedPrice
	channel.SetOtherSettings(settings)

	row := buildChannelPriceCompareRow(
		channel, "grp", "test-model", snapshotWithTestModel(), 2.5,
	)

	assert.Equal(t, "detected", row.PriceSource)
	assert.InDelta(t, 3.0, row.UpstreamInput, 1e-9)
}

func TestBuildChannelPriceCompareRowFallsBackToModelsDevForInvalidDetection(t *testing.T) {
	setupPriceCompareRatios(t)
	zeroInput := snapshotWithTestModel()
	zeroInput.GroupRatios["grp"] = 0
	overflow := snapshotWithTestModel()
	overflow.QuotaPerUnit = 1_000_000
	overflow.Models["test-model"] = upstreamPricingModel{
		ModelRatio:       5,
		CompletionRatio:  math.MaxFloat64,
		CacheRatio:       0.1,
		CreateCacheRatio: 1.25,
	}

	for name, snapshot := range map[string]upstreamPricingSnapshot{
		"zero input": zeroInput,
		"overflow":   overflow,
	} {
		t.Run(name, func(t *testing.T) {
			row := buildChannelPriceCompareRow(
				newOfficialPriceCompareChannel(), "grp", "test-model", snapshot, 2.5,
			)

			assert.Equal(t, "models_dev", row.PriceSource)
			assert.False(t, row.DetectedAvailable)
			assert.Zero(t, row.DetectedInput)
			assert.Zero(t, row.DetectedOutput)
			assert.Zero(t, row.DetectedCacheRead)
			assert.Zero(t, row.DetectedCacheWrite)
			assert.InDelta(t, 9.0, row.UpstreamInput, 1e-9)
			assert.InDelta(t, 45.0, row.UpstreamOutput, 1e-9)
			_, err := common.Marshal(row)
			require.NoError(t, err)
		})
	}
}

func TestBuildChannelPriceCompareRowUsesModelsDevWhenDetectionUnavailable(t *testing.T) {
	setupPriceCompareRatios(t)

	row := buildChannelPriceCompareRow(
		newOfficialPriceCompareChannel(),
		"",
		"test-model",
		upstreamPricingSnapshot{},
		2.5,
	)

	assert.Equal(t, "ok", row.Status)
	assert.Equal(t, "models_dev", row.PriceSource)
	require.NotNil(t, row.UsesOfficialPricing)
	assert.True(t, *row.UsesOfficialPricing)
	assert.False(t, row.DetectedAvailable)
	assert.InDelta(t, 9.0, row.UpstreamInput, 1e-9)
	assert.InDelta(t, 45.0, row.UpstreamOutput, 1e-9)
}

func TestBuildChannelPriceCompareRowRejectsZeroInputDetectedBasis(t *testing.T) {
	setupPriceCompareRatios(t)
	snapshot := snapshotWithTestModel()
	snapshot.GroupRatios["grp"] = 0

	row := buildChannelPriceCompareRow(
		newPriceCompareChannel(),
		"grp",
		"test-model",
		snapshot,
		2.5,
	)

	assert.Equal(t, "unknown", row.Status)
	assert.False(t, row.DetectedAvailable)
	assert.Zero(t, row.UpstreamInput)
}

func TestBuildChannelPriceCompareRowUnknownBranches(t *testing.T) {
	setupPriceCompareRatios(t)
	snapshot := snapshotWithTestModel()

	// 未标注上游分组
	row := buildChannelPriceCompareRow(newPriceCompareChannel(), "", "test-model", snapshot, 2.5)
	assert.Equal(t, "unknown", row.Status)
	assert.Equal(t, "No upstream group or purchase price", row.StatusReason)
	// 本地价仍应算出（用户售价与上游无关）
	assert.InDelta(t, 25.0, row.LocalInput, 1e-9)
	assert.Zero(t, row.UpstreamInput)

	// 上游无该分组倍率
	row = buildChannelPriceCompareRow(newPriceCompareChannel(), "missing-grp", "test-model", snapshot, 2.5)
	assert.Equal(t, "unknown", row.Status)
	assert.Equal(t, "Upstream pricing group not found", row.StatusReason)

	// 上游无该模型
	row = buildChannelPriceCompareRow(newPriceCompareChannel(), "grp", "absent-model", snapshot, 2.5)
	assert.Equal(t, "unknown", row.Status)
	assert.Equal(t, "Upstream model price not found", row.StatusReason)
}

func TestLoadUpstreamProbeConfigs(t *testing.T) {
	common.OptionMapRWMutex.Lock()
	if common.OptionMap == nil {
		common.OptionMap = make(map[string]string)
	}
	common.OptionMap[UpstreamProbeConfigsOptionKey] = `[{"base_url":"https://cdn.example.com","access_token":"tok","user_id":"1"}]`
	common.OptionMapRWMutex.Unlock()

	configs, err := LoadUpstreamProbeConfigs()
	require.NoError(t, err)
	require.Len(t, configs, 1)
	assert.Equal(t, "https://cdn.example.com", configs[0].BaseURL)
	assert.Equal(t, "tok", configs[0].AccessToken)
	assert.Equal(t, "1", configs[0].UserID)

	common.OptionMapRWMutex.Lock()
	common.OptionMap[UpstreamProbeConfigsOptionKey] = "[]"
	common.OptionMapRWMutex.Unlock()
	configs, err = LoadUpstreamProbeConfigs()
	require.NoError(t, err)
	assert.Empty(t, configs)
}

// 上游偶发失败时，探测应重试并在后续尝试成功（对应生产 context deadline exceeded 修复）。
func TestProbeUpstreamPricingRetriesOnFailure(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&calls, 1) == 1 {
			w.WriteHeader(http.StatusInternalServerError) // 首次失败，触发重试
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"quota_per_unit":1000000,"group_ratio":{"g":0.3},"data":[{"model_name":"m","quota_type":0,"model_ratio":5,"completion_ratio":5,"cache_ratio":0.1,"create_cache_ratio":1.25},{"model_name":"fixed","quota_type":1,"model_price":0.1}]}`))
	}))
	defer srv.Close()

	snapshot, err := probeUpstreamPricing(context.Background(), UpstreamProbeConfig{BaseURL: srv.URL})
	require.NoError(t, err)
	assert.EqualValues(t, 2, atomic.LoadInt32(&calls)) // 第一次失败，第二次成功
	assert.Contains(t, snapshot.Models, "m")
	assert.NotContains(t, snapshot.Models, "fixed")
	assert.InDelta(t, 0.3, snapshot.GroupRatios["g"], 1e-9)
	assert.InDelta(t, 1_000_000, snapshot.QuotaPerUnit, 1e-9)
}

func TestProbeUpstreamPricingSkipsIncompleteTokenPrices(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"group_ratio":{"g":0.3},"data":[{"model_name":"no-cache-write","quota_type":0,"model_ratio":5,"completion_ratio":5,"cache_ratio":0.1},{"model_name":"negative-cache-write","quota_type":0,"model_ratio":5,"completion_ratio":5,"cache_ratio":0.1,"create_cache_ratio":-1},{"model_name":"free","quota_type":0,"model_ratio":0,"completion_ratio":0,"cache_ratio":0,"create_cache_ratio":0}]}`))
	}))
	defer srv.Close()

	snapshot, err := probeUpstreamPricingOnce(context.Background(), UpstreamProbeConfig{BaseURL: srv.URL})

	require.NoError(t, err)
	// 上游未配置缓存写入倍率的模型按 0 计入快照，不能整条丢弃
	require.Contains(t, snapshot.Models, "no-cache-write")
	assert.Zero(t, snapshot.Models["no-cache-write"].CreateCacheRatio)
	assert.NotContains(t, snapshot.Models, "negative-cache-write")
	assert.Contains(t, snapshot.Models, "free")
}

func TestProbeChannelUpstreamsUsesCredentialSafeLabels(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	base := strings.Replace(srv.URL, "http://", "http://user:secret@", 1)
	channel := &model.Channel{
		Id: 7, Name: "safe-channel", BaseURL: common.GetPointer(base),
	}

	_, probeErrors := probeChannelUpstreams(
		context.Background(),
		[]*model.Channel{channel},
		map[string]UpstreamProbeConfig{
			normalizeUpstreamBaseURL(base): {BaseURL: base},
		},
	)

	assert.Equal(t, "Upstream probe authentication failed", probeErrors["safe-channel (#7)"])
	for label := range probeErrors {
		assert.NotContains(t, label, "user")
		assert.NotContains(t, label, "secret")
	}
}

func TestBuildChannelPriceCompareReportShowsRoutingAndBusinessMetrics(t *testing.T) {
	originalDB := model.DB
	originalLogDB := model.LOG_DB
	originalQuotaPerUnit := common.QuotaPerUnit
	originalModelPrices := ratio_setting.ModelPrice2JSONString()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "channel-operations.db")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.Ability{}, &model.Log{}))
	model.DB = db
	model.LOG_DB = db
	common.QuotaPerUnit = 500000
	t.Cleanup(func() {
		model.DB = originalDB
		model.LOG_DB = originalLogDB
		common.QuotaPerUnit = originalQuotaPerUnit
		require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(originalModelPrices))
	})

	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"test-model":5}`))
	require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(`{"test-model":2}`))
	require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(`{"fixed-model":0.1}`))
	common.OptionMapRWMutex.Lock()
	if common.OptionMap == nil {
		common.OptionMap = make(map[string]string)
	}
	common.OptionMap[UpstreamProbeConfigsOptionKey] = "[]"
	common.OptionMapRWMutex.Unlock()

	primaryPriority := int64(100)
	backupPriority := int64(50)
	disabledPriority := int64(200)
	primary := model.Channel{
		Id: 1, Name: "primary", Status: common.ChannelStatusEnabled, Models: "test-model,unpriced-model",
		Group: "default", Priority: &primaryPriority, Weight: common.GetPointer(uint(20)),
	}
	primary.SetOtherSettings(dto.ChannelOtherSettings{
		PACUpstreamGroup: "premium",
		ModelPrices: map[string]dto.ChannelModelPrice{
			"test-model": {
				Input:      channelPriceValue(2),
				Output:     channelPriceValue(8),
				CacheRead:  channelPriceValue(0.2),
				CacheWrite: channelPriceValue(2.5),
			},
		},
	})
	backup := model.Channel{
		Id: 2, Name: "backup", Status: common.ChannelStatusEnabled, Models: "test-model",
		Group: "default", Priority: &backupPriority, Weight: common.GetPointer(uint(10)),
	}
	backup.SetOtherSettings(dto.ChannelOtherSettings{
		PACUpstreamGroup: "economy",
		ModelPrices: map[string]dto.ChannelModelPrice{
			"test-model": {
				Input:      channelPriceValue(1),
				Output:     channelPriceValue(4),
				CacheRead:  channelPriceValue(0),
				CacheWrite: channelPriceValue(0),
			},
		},
	})
	disabled := model.Channel{
		Id: 3, Name: "disabled", Status: common.ChannelStatusManuallyDisabled, Models: "test-model",
		Group: "default", Priority: &disabledPriority, Weight: common.GetPointer(uint(100)),
	}
	require.NoError(t, db.Create(&primary).Error)
	require.NoError(t, db.Create(&backup).Error)
	require.NoError(t, db.Create(&disabled).Error)
	require.NoError(t, db.Create([]model.Ability{
		{Group: "default", Model: "test-model", ChannelId: 1, Enabled: true, Priority: &primaryPriority, Weight: 20},
		{Group: "default", Model: "test-model", ChannelId: 2, Enabled: true, Priority: &backupPriority, Weight: 10},
		{Group: "default", Model: "test-model", ChannelId: 3, Enabled: true, Priority: &disabledPriority, Weight: 100},
		{Group: "default", Model: "fixed-model", ChannelId: 1, Enabled: true, Priority: &primaryPriority, Weight: 20},
		{Group: "default", Model: "unpriced-model", ChannelId: 1, Enabled: true, Priority: &primaryPriority, Weight: 20},
	}).Error)

	now := time.Now().Unix()
	require.NoError(t, db.Create(&model.Log{
		CreatedAt: now, Type: model.LogTypeConsume, ChannelId: 1, ModelName: "test-model",
		Quota: 500000, PromptTokens: 1000000, CompletionTokens: 100000, UseTime: 2,
		Other: `{"cache_tokens":200000,"cache_write_tokens":100000}`,
	}).Error)
	require.NoError(t, db.Create(&model.Log{
		CreatedAt: now - 48*60*60, Type: model.LogTypeConsume, ChannelId: 1, ModelName: "test-model",
		Quota: 1000000, PromptTokens: 500000, CompletionTokens: 0, UseTime: 1, Other: "{malformed",
	}).Error)
	for i := range 20 {
		errorContent := "upstream unavailable"
		createdAt := now - int64(i)
		if i == 0 {
			errorContent = "Authorization: Bearer sk-secret-value"
		} else if i == 1 {
			errorContent = "upstream timeout"
			createdAt = now
		}
		require.NoError(t, db.Create(&model.Log{
			CreatedAt: createdAt, Type: model.LogTypeError, ChannelId: 2,
			ModelName: "test-model", Content: errorContent,
		}).Error)
	}

	report, err := BuildChannelPriceCompareReport(context.Background(), "default")
	require.NoError(t, err)
	require.Len(t, report.Models, 3)
	modelRows := make(map[string]ChannelPriceCompareModelRow, len(report.Models))
	for _, row := range report.Models {
		modelRows[row.ModelName] = row
	}
	require.Len(t, modelRows["test-model"].Channels, 2)
	require.Len(t, modelRows["fixed-model"].Channels, 1)
	require.Len(t, modelRows["unpriced-model"].Channels, 1)
	unpricedRow := modelRows["unpriced-model"].Channels[0]
	assert.Equal(t, "missing", unpricedRow.PriceSource)
	assert.Equal(t, "unknown", unpricedRow.Status)
	fixedRow := modelRows["fixed-model"].Channels[0]
	assert.True(t, fixedRow.UsesFixedPrice)
	assert.InDelta(t, 0.1, fixedRow.FixedPrice, 1e-9)

	primaryRow := modelRows["test-model"].Channels[0]
	assert.Equal(t, "primary", primaryRow.RoutingRole)
	assert.Equal(t, "manual", primaryRow.PriceSource)
	assert.InDelta(t, 1.0, primaryRow.Today.Revenue, 1e-9)
	assert.InDelta(t, 2.49, primaryRow.Today.UpstreamCost, 1e-9)
	assert.InDelta(t, -1.49, primaryRow.Today.Profit, 1e-9)
	assert.EqualValues(t, 1, primaryRow.Today.Requests)
	assert.EqualValues(t, 2, primaryRow.Total.Requests)

	backupRow := modelRows["test-model"].Channels[1]
	assert.Equal(t, "backup", backupRow.RoutingRole)
	assert.EqualValues(t, 20, backupRow.Quality24h.Errors)
	assert.Equal(t, "Upstream request timed out", backupRow.Quality24h.LastErrorCode)
	assert.Contains(t, backupRow.Recommendations, "low_success_rate")
	assert.InDelta(t, 1.0, report.Summary.Today.Revenue, 1e-9)
	assert.Equal(t, 2, report.Summary.RiskChannels)
}

func TestBuildChannelBusinessMetricsLeavesMissingCostUnknown(t *testing.T) {
	metrics := buildChannelBusinessMetrics(
		channelUsageAggregate{Requests: 1, Quota: 500000, InputTokens: 1000},
		ChannelPriceCompareChannel{PriceSource: "missing"},
	)

	assert.False(t, metrics.CostAvailable)
	assert.InDelta(t, 1.0, metrics.Revenue, 1e-9)
	assert.Zero(t, metrics.Profit)
}

func TestTieredSellingPricesUsePerMillionCoefficientsAndGroupRatio(t *testing.T) {
	originalQuotaPerUnit := common.QuotaPerUnit
	common.QuotaPerUnit = 500_000
	t.Cleanup(func() {
		common.QuotaPerUnit = originalQuotaPerUnit
	})

	prices, err := tieredSellingPrices(
		`tier("base", p * 3.6 + c * 20 + cr * 0.36 + cc * 4.5 + cc1h * 4.5)`,
		2.5,
	)

	require.NoError(t, err)
	assert.InDelta(t, 9.0, prices.Input, 1e-9)
	assert.InDelta(t, 50.0, prices.Output, 1e-9)
	assert.InDelta(t, 0.9, prices.CacheRead, 1e-9)
	assert.InDelta(t, 11.25, prices.CacheWrite, 1e-9)
}

func TestSummarizeChannelPriceCompareClearsPartialCosts(t *testing.T) {
	rows := []ChannelPriceCompareModelRow{
		{
			ModelName: "priced",
			Channels: []ChannelPriceCompareChannel{{
				ChannelID: 1, ChannelName: "channel",
				Today: ChannelBusinessMetrics{
					Requests: 1, Revenue: 2, UpstreamCost: 1, Profit: 1, Margin: 50, CostAvailable: true,
				},
				Total: ChannelBusinessMetrics{CostAvailable: true},
			}},
		},
		{
			ModelName: "missing",
			Channels: []ChannelPriceCompareChannel{{
				ChannelID: 1, ChannelName: "channel",
				Today: ChannelBusinessMetrics{
					Requests: 1, Revenue: 1, CostAvailable: false,
				},
				Total: ChannelBusinessMetrics{CostAvailable: true},
			}},
		},
	}

	summary, channels := summarizeChannelPriceCompare(rows)

	assert.False(t, summary.Today.CostAvailable)
	assert.InDelta(t, 3.0, summary.Today.Revenue, 1e-9)
	assert.Zero(t, summary.Today.UpstreamCost)
	assert.Zero(t, summary.Today.Profit)
	require.Len(t, channels, 1)
	assert.False(t, channels[0].Today.CostAvailable)
	assert.Zero(t, channels[0].Today.Profit)
}

func TestChannelRecommendationsIncludesCacheLoss(t *testing.T) {
	row := ChannelPriceCompareChannel{
		PriceSource:        "manual",
		LocalInput:         10,
		LocalOutput:        10,
		LocalCacheRead:     0.1,
		LocalCacheWrite:    0,
		UpstreamInput:      1,
		UpstreamOutput:     1,
		UpstreamCacheRead:  0.2,
		UpstreamCacheWrite: 0.1,
	}

	assert.Contains(t, channelRecommendations(row), "negative_margin")
}

func TestChannelRecommendationsIncludesRealizedLowMarginForFixedPrice(t *testing.T) {
	row := ChannelPriceCompareChannel{
		PriceSource:    "manual",
		UsesFixedPrice: true,
		Today: ChannelBusinessMetrics{
			Requests:      5,
			Revenue:       10,
			UpstreamCost:  8,
			Profit:        2,
			Margin:        20,
			CostAvailable: true,
		},
	}

	assert.Contains(t, channelRecommendations(row), "low_margin")
	assert.NotContains(t, channelRecommendations(row), "negative_margin")
}

func TestLoadChannelQualityFiltersExactPairs(t *testing.T) {
	originalLogDB := model.LOG_DB
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "channel-quality.db")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.Log{}))
	model.LOG_DB = db
	t.Cleanup(func() {
		model.LOG_DB = originalLogDB
	})
	now := time.Now().Unix()
	require.NoError(t, db.Create([]model.Log{
		{CreatedAt: now, Type: model.LogTypeError, ChannelId: 1, ModelName: "model-b", Content: "cross-pair"},
		{CreatedAt: now, Type: model.LogTypeError, ChannelId: 2, ModelName: "model-b", Content: "timeout"},
	}).Error)

	quality, err := loadChannelQuality(
		[]channelModelPair{
			{ChannelID: 1, ModelName: "model-a"},
			{ChannelID: 2, ModelName: "model-b"},
		},
		now-60,
	)

	require.NoError(t, err)
	assert.NotContains(t, quality, channelPriceCompareUsageKey(1, "model-b"))
	assert.Equal(t, "Upstream request timed out", quality[channelPriceCompareUsageKey(2, "model-b")].LastErrorCode)
}

func TestChannelMetricsQueriesBatchLargePairSets(t *testing.T) {
	originalLogDB := model.LOG_DB
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "channel-batches.db")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.Log{}))
	model.LOG_DB = db
	t.Cleanup(func() {
		model.LOG_DB = originalLogDB
	})

	now := time.Now().Unix()
	require.NoError(t, db.Create(&model.Log{
		CreatedAt: now,
		Type:      model.LogTypeConsume,
		ChannelId: 1200,
		ModelName: "model-1200",
		Quota:     500000,
	}).Error)
	pairs := make([]channelModelPair, 0, 1200)
	for id := 1; id <= 1200; id++ {
		pairs = append(pairs, channelModelPair{
			ChannelID: id,
			ModelName: fmt.Sprintf("model-%d", id),
		})
	}

	usage, err := loadChannelUsage(pairs, now-60)
	require.NoError(t, err)
	assert.EqualValues(t, 1, usage[channelPriceCompareUsageKey(1200, "model-1200")].Requests)

	quality, err := loadChannelQuality(pairs, now-60)
	require.NoError(t, err)
	assert.EqualValues(t, 1, quality[channelPriceCompareUsageKey(1200, "model-1200")].Successes)
}
