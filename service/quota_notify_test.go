package service

import (
	"testing"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/setting/operation_setting"
)

func TestRemainingWalletQuotaForNotifyUsesPostConsumeBalance(t *testing.T) {
	t.Parallel()

	got := remainingWalletQuotaForNotify(1_000_000, 100_000, 450_000)

	if got != 450_000 {
		t.Fatalf("expected post-consume quota 450000, got %d", got)
	}
}

func TestBuildWalletQuotaNotifyUsesPostConsumeBalanceInPayload(t *testing.T) {
	originalDisplayType := operation_setting.GetGeneralSetting().QuotaDisplayType
	operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeTokens
	t.Cleanup(func() {
		operation_setting.GetGeneralSetting().QuotaDisplayType = originalDisplayType
	})

	notify, ok := buildWalletQuotaNotify(&relaycommon.RelayInfo{
		UserQuota:   1_000_000,
		UserSetting: dto.UserSetting{NotifyType: dto.NotifyTypeWebhook},
	}, 100_000, 450_000, 500_000)

	if !ok {
		t.Fatal("expected quota notification to be built")
	}
	if notify.Values[1] != "450000" {
		t.Fatalf("expected payload balance 450000, got %v", notify.Values[1])
	}
}
