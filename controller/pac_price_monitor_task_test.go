package controller

import (
	"testing"
	"time"

	"github.com/QuantumNous/new-api/model"

	"github.com/stretchr/testify/require"
)

func TestPACPriceMonitorHandlerDefaultsToDailySchedule(t *testing.T) {
	handler := pacPriceMonitorHandler{}

	require.Equal(t, model.SystemTaskTypePACPriceMonitor, handler.Type())
	require.True(t, handler.Enabled())
	require.Equal(t, 24*time.Hour, handler.Interval())
}
