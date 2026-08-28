package ratio_setting

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func enabledCfg() PeakRatioConfig {
	cfg := defaultPeakRatioConfig()
	cfg.Enabled = true
	return cfg
}

// utc 构造一个 UTC 时刻，便于验证时区换算到北京时间后的时段判断。
func utc(hour, min int) time.Time {
	return time.Date(2026, 7, 20, hour, min, 0, 0, time.UTC)
}

func TestGetPeakMultiplierAt_Disabled(t *testing.T) {
	cfg := defaultPeakRatioConfig() // Enabled=false
	// 北京 10:00（UTC 02:00）本在高峰窗口，但未启用应返回 1.0/false。
	got, isPeak := getPeakMultiplierAt(cfg, "deepseek-chat", utc(2, 0))
	if got != 1.0 || isPeak {
		t.Fatalf("disabled: want (1.0,false), got (%v,%v)", got, isPeak)
	}
}

func TestGetPeakMultiplierAt_MultiplierNotAbove1(t *testing.T) {
	cfg := enabledCfg()
	cfg.Multiplier = 1.0
	got, isPeak := getPeakMultiplierAt(cfg, "deepseek-chat", utc(2, 0))
	if got != 1.0 || isPeak {
		t.Fatalf("multiplier=1: want (1.0,false), got (%v,%v)", got, isPeak)
	}
}

func TestGetPeakMultiplierAt_PeakHit(t *testing.T) {
	cfg := enabledCfg() // multiplier 2.0, windows 09-12/14-18, models [deepseek]
	// 北京 10:30 == UTC 02:30，命中 09:00-12:00。
	got, isPeak := getPeakMultiplierAt(cfg, "deepseek-chat", utc(2, 30))
	if got != 2.0 || !isPeak {
		t.Fatalf("peak morning: want (2.0,true), got (%v,%v)", got, isPeak)
	}
	// 北京 15:00 == UTC 07:00，命中 14:00-18:00。
	got, isPeak = getPeakMultiplierAt(cfg, "deepseek-reasoner", utc(7, 0))
	if got != 2.0 || !isPeak {
		t.Fatalf("peak afternoon: want (2.0,true), got (%v,%v)", got, isPeak)
	}
}

func TestGetPeakMultiplierAt_WeekendSetting(t *testing.T) {
	defaultCfg := enabledCfg()
	require.True(t, defaultCfg.WeekendEnabled, "existing configurations must keep weekend peak pricing enabled")

	tests := []struct {
		name           string
		day            int
		weekendEnabled bool
		wantMultiplier float64
		wantPeak       bool
	}{
		{name: "weekday when weekends disabled", day: 20, weekendEnabled: false, wantMultiplier: 2.0, wantPeak: true},
		{name: "saturday when weekends disabled", day: 18, weekendEnabled: false, wantMultiplier: 1.0, wantPeak: false},
		{name: "sunday when weekends disabled", day: 19, weekendEnabled: false, wantMultiplier: 1.0, wantPeak: false},
		{name: "saturday when weekends enabled", day: 18, weekendEnabled: true, wantMultiplier: 2.0, wantPeak: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := enabledCfg()
			cfg.WeekendEnabled = tt.weekendEnabled
			now := time.Date(2026, time.July, tt.day, 10, 0, 0, 0, beijingZone)

			gotMultiplier, gotPeak := getPeakMultiplierAt(cfg, "deepseek-chat", now)

			assert.Equal(t, tt.wantMultiplier, gotMultiplier)
			assert.Equal(t, tt.wantPeak, gotPeak)
		})
	}

	t.Run("weekend uses configured timezone", func(t *testing.T) {
		cfg := enabledCfg()
		cfg.WeekendEnabled = false
		cfg.Windows = []PeakWindow{{Start: "00:00", End: "23:59"}}
		fridayUTC := time.Date(2026, time.July, 17, 20, 0, 0, 0, time.UTC)

		gotMultiplier, gotPeak := getPeakMultiplierAt(cfg, "deepseek-chat", fridayUTC)

		assert.Equal(t, 1.0, gotMultiplier)
		assert.False(t, gotPeak, "UTC Friday is already Saturday in the configured Beijing timezone")
	})
}

func TestGetPeakMultiplierAt_OffPeakTime(t *testing.T) {
	cfg := enabledCfg()
	// 北京 13:00 == UTC 05:00，午休不在任何窗口。
	got, isPeak := getPeakMultiplierAt(cfg, "deepseek-chat", utc(5, 0))
	if got != 1.0 || isPeak {
		t.Fatalf("off-peak noon break: want (1.0,false), got (%v,%v)", got, isPeak)
	}
	// 北京 08:00 == UTC 00:00，早于高峰。
	got, isPeak = getPeakMultiplierAt(cfg, "deepseek-chat", utc(0, 0))
	if got != 1.0 || isPeak {
		t.Fatalf("off-peak morning: want (1.0,false), got (%v,%v)", got, isPeak)
	}
}

func TestGetPeakMultiplierAt_ModelNotMatched(t *testing.T) {
	cfg := enabledCfg()
	// 高峰时段但模型不在列表。
	got, isPeak := getPeakMultiplierAt(cfg, "gpt-4o", utc(2, 30))
	if got != 1.0 || isPeak {
		t.Fatalf("model not matched: want (1.0,false), got (%v,%v)", got, isPeak)
	}
}

func TestGetPeakMultiplierAt_WindowBoundary(t *testing.T) {
	cfg := enabledCfg()
	// 含左：北京 09:00（UTC 01:00）算高峰。
	if got, isPeak := getPeakMultiplierAt(cfg, "deepseek-chat", utc(1, 0)); got != 2.0 || !isPeak {
		t.Fatalf("boundary 09:00 inclusive: want (2.0,true), got (%v,%v)", got, isPeak)
	}
	// 不含右：北京 12:00（UTC 04:00）不算高峰。
	if got, isPeak := getPeakMultiplierAt(cfg, "deepseek-chat", utc(4, 0)); got != 1.0 || isPeak {
		t.Fatalf("boundary 12:00 exclusive: want (1.0,false), got (%v,%v)", got, isPeak)
	}
}

func TestGetPeakMultiplierAt_PrefixMatchCaseInsensitive(t *testing.T) {
	cfg := enabledCfg()
	cfg.Models = []string{"DeepSeek"}
	if got, isPeak := getPeakMultiplierAt(cfg, "deepseek-v3-chat", utc(2, 30)); got != 2.0 || !isPeak {
		t.Fatalf("case-insensitive prefix: want (2.0,true), got (%v,%v)", got, isPeak)
	}
}

func TestGetPeakMultiplierAt_CrossMidnightWindow(t *testing.T) {
	cfg := enabledCfg()
	cfg.Models = []string{"any"}
	cfg.Windows = []PeakWindow{{Start: "22:00", End: "02:00"}}
	// 北京 23:00 == UTC 15:00，落在跨午夜窗口内。
	if got, isPeak := getPeakMultiplierAt(cfg, "any-model", utc(15, 0)); got != 2.0 || !isPeak {
		t.Fatalf("cross-midnight in: want (2.0,true), got (%v,%v)", got, isPeak)
	}
	// 北京 03:00 == UTC 19:00（前一日），窗口外。
	if got, isPeak := getPeakMultiplierAt(cfg, "any-model", utc(19, 0)); got != 1.0 || isPeak {
		t.Fatalf("cross-midnight out: want (1.0,false), got (%v,%v)", got, isPeak)
	}
}

func TestGetPeakMultiplierAt_CustomTimezone(t *testing.T) {
	cfg := enabledCfg()
	cfg.Timezone = "UTC"
	cfg.Models = []string{"deepseek"}
	// 时区设为 UTC 时，UTC 10:00 应命中 09:00-12:00。
	if got, isPeak := getPeakMultiplierAt(cfg, "deepseek-chat", utc(10, 0)); got != 2.0 || !isPeak {
		t.Fatalf("utc tz peak: want (2.0,true), got (%v,%v)", got, isPeak)
	}
	// UTC 02:00 在 UTC 时区下不是高峰（而北京时区下会是）。
	if got, isPeak := getPeakMultiplierAt(cfg, "deepseek-chat", utc(2, 0)); got != 1.0 || isPeak {
		t.Fatalf("utc tz off-peak: want (1.0,false), got (%v,%v)", got, isPeak)
	}
}

func TestParseHHMM(t *testing.T) {
	cases := []struct {
		in   string
		want int
		ok   bool
	}{
		{"09:00", 540, true},
		{"00:00", 0, true},
		{"23:59", 1439, true},
		{" 14:30 ", 870, true},
		{"24:00", 0, false},
		{"12:60", 0, false},
		{"12", 0, false},
		{"ab:cd", 0, false},
		{"", 0, false},
	}
	for _, c := range cases {
		got, ok := parseHHMM(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Fatalf("parseHHMM(%q): want (%d,%v), got (%d,%v)", c.in, c.want, c.ok, got, ok)
		}
	}
}

func TestValidatePeakRatioConfig(t *testing.T) {
	if err := ValidatePeakRatioConfig(enabledCfg()); err != nil {
		t.Fatalf("default cfg should be valid: %v", err)
	}
	bad := enabledCfg()
	bad.Windows = []PeakWindow{{Start: "9am", End: "12:00"}}
	if err := ValidatePeakRatioConfig(bad); err == nil {
		t.Fatal("invalid window start should error")
	}
	badMul := enabledCfg()
	badMul.Multiplier = -1
	if err := ValidatePeakRatioConfig(badMul); err == nil {
		t.Fatal("negative multiplier should error")
	}
}
