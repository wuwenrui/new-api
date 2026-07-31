package controller

import (
	"testing"
	"time"

	"github.com/QuantumNous/new-api/model"

	"github.com/stretchr/testify/require"
)

func TestChannelBalanceMonitorHandlerDefaultsToSixHourSchedule(t *testing.T) {
	handler := channelBalanceMonitorHandler{}

	require.Equal(t, model.SystemTaskTypeChannelBalanceMonitor, handler.Type())
	require.True(t, handler.Enabled())
	require.Equal(t, 6*time.Hour, handler.Interval())
}
