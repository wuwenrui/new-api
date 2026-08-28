package ratio_setting

import (
	"errors"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/setting/config"
)

// 峰谷计价（peak/off-peak pricing）：在高峰时段对命中模型的模型倍率（model_ratio）
// 乘以一个可配的系数（multiplier），从而让高峰期所有按倍率计费的项目（prompt /
// completion / cache）同步放大。系数只作用在 model_ratio 上，因此“适用所有计费项”。
//
// 时区：默认按北京时间（UTC+8，无夏令时）判断，不依赖服务器本地时区，也不依赖系统
// 时区库（tzdata）。管理员可显式配置其他 IANA 时区名，加载失败时回退到 UTC+8。

const (
	// defaultPeakMultiplier 默认峰值系数，DeepSeek 高峰为平时价格 2 倍。
	defaultPeakMultiplier = 2.0
	// defaultPeakTimezone 默认时区，北京时间。
	defaultPeakTimezone = "Asia/Shanghai"
)

// PeakWindow 表示一个高峰时段，Start/End 为 24 小时制 "HH:MM"，含左不含右 [Start, End)。
type PeakWindow struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

// PeakRatioConfig 峰谷计价配置。
type PeakRatioConfig struct {
	Enabled        bool         `json:"enabled"`
	WeekendEnabled bool         `json:"weekend_enabled"`
	Multiplier     float64      `json:"multiplier"`
	Timezone       string       `json:"timezone"`
	Models         []string     `json:"models"`
	Windows        []PeakWindow `json:"windows"`
}

var (
	peakRatioMu     sync.RWMutex
	peakRatioConfig = defaultPeakRatioConfig()
)

func defaultPeakRatioConfig() PeakRatioConfig {
	return PeakRatioConfig{
		Enabled: false,
		// 兼容旧配置：未持久化该字段时保持原有周末计价行为。
		WeekendEnabled: true,
		Multiplier:     defaultPeakMultiplier,
		Timezone:       defaultPeakTimezone,
		// 预置 DeepSeek 系列前缀，管理员可增删。
		Models: []string{"deepseek"},
		// DeepSeek 官方高峰：北京时间 09:00-12:00 与 14:00-18:00。
		Windows: []PeakWindow{
			{Start: "09:00", End: "12:00"},
			{Start: "14:00", End: "18:00"},
		},
	}
}

// peakRatioSetting 供 config.GlobalConfig 持久化（options 表键前缀 peak_ratio_setting.）。
var peakRatioSetting = defaultPeakRatioConfig()

func init() {
	config.GlobalConfig.Register("peak_ratio_setting", &peakRatioSetting)
	syncPeakConfigFromSetting()
}

// syncPeakConfigFromSetting 把 config 加载/保存用的 peakRatioSetting 同步到读侧快照。
func syncPeakConfigFromSetting() {
	peakRatioMu.Lock()
	defer peakRatioMu.Unlock()
	peakRatioConfig = peakRatioSetting
}

// GetPeakRatioConfig 返回当前峰谷配置的副本。
func GetPeakRatioConfig() PeakRatioConfig {
	peakRatioMu.RLock()
	defer peakRatioMu.RUnlock()
	return peakRatioConfig
}

// ReloadPeakRatioFromSetting 在 config 更新 peakRatioSetting 之后调用，刷新读侧快照。
func ReloadPeakRatioFromSetting() {
	syncPeakConfigFromSetting()
}

// GetPeakMultiplier 返回给某模型此刻应用的峰值系数与是否处于高峰。
// 未启用 / 系数无效 / 模型未命中 / 不在高峰时段时，返回 (1.0, false)。
func GetPeakMultiplier(modelName string) (float64, bool) {
	return getPeakMultiplierAt(GetPeakRatioConfig(), modelName, time.Now())
}

// getPeakMultiplierAt 是可注入时间的纯函数，便于测试。
func getPeakMultiplierAt(cfg PeakRatioConfig, modelName string, now time.Time) (float64, bool) {
	if !cfg.Enabled {
		return 1.0, false
	}
	if !(cfg.Multiplier > 1.0) {
		// 系数 <=1 无放大意义，视为未生效，避免误伤计费。
		return 1.0, false
	}
	if !matchPeakModel(cfg.Models, modelName) {
		return 1.0, false
	}
	local := now.In(peakLocation(cfg.Timezone))
	if !cfg.WeekendEnabled && (local.Weekday() == time.Saturday || local.Weekday() == time.Sunday) {
		return 1.0, false
	}
	nowMinutes := local.Hour()*60 + local.Minute()
	if !inAnyPeakWindow(cfg.Windows, nowMinutes) {
		return 1.0, false
	}
	return cfg.Multiplier, true
}

func matchPeakModel(models []string, modelName string) bool {
	if modelName == "" {
		return false
	}
	target := strings.ToLower(modelName)
	for _, m := range models {
		m = strings.ToLower(strings.TrimSpace(m))
		if m == "" {
			continue
		}
		if strings.HasPrefix(target, m) {
			return true
		}
	}
	return false
}

func inAnyPeakWindow(windows []PeakWindow, nowMinutes int) bool {
	for _, w := range windows {
		start, ok1 := parseHHMM(w.Start)
		end, ok2 := parseHHMM(w.End)
		if !ok1 || !ok2 || start == end {
			continue
		}
		if start < end {
			// 常规同日窗口 [start, end)
			if nowMinutes >= start && nowMinutes < end {
				return true
			}
		} else {
			// 跨午夜窗口，如 22:00-02:00
			if nowMinutes >= start || nowMinutes < end {
				return true
			}
		}
	}
	return false
}

// parseHHMM 解析 "HH:MM" 为当天分钟数 [0,1440)。非法返回 ok=false。
func parseHHMM(s string) (int, bool) {
	s = strings.TrimSpace(s)
	parts := strings.Split(s, ":")
	if len(parts) != 2 {
		return 0, false
	}
	h, err := strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil || h < 0 || h > 23 {
		return 0, false
	}
	m, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil || m < 0 || m > 59 {
		return 0, false
	}
	return h*60 + m, true
}

var beijingZone = time.FixedZone("CST", 8*3600)

// peakLocation 返回时区。空或 Asia/Shanghai 直接用固定 UTC+8（零系统依赖）；
// 其他时区尝试 LoadLocation，失败回退 UTC+8。
func peakLocation(tz string) *time.Location {
	tz = strings.TrimSpace(tz)
	if tz == "" || tz == defaultPeakTimezone {
		return beijingZone
	}
	if loc, err := time.LoadLocation(tz); err == nil {
		return loc
	}
	return beijingZone
}

// ValidatePeakRatioConfig 校验配置合法性，供保存前调用。
func ValidatePeakRatioConfig(cfg PeakRatioConfig) error {
	if cfg.Multiplier < 0 {
		return errors.New("peak multiplier must be >= 0")
	}
	for _, w := range cfg.Windows {
		if _, ok := parseHHMM(w.Start); !ok {
			return errors.New("invalid peak window start: " + w.Start)
		}
		if _, ok := parseHHMM(w.End); !ok {
			return errors.New("invalid peak window end: " + w.End)
		}
	}
	return nil
}
