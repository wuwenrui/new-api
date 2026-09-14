package service

import (
	"math"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestTokenBillingNumericBoundary(t *testing.T) {
	for _, test := range []struct {
		name  string
		value float64
		valid bool
	}{
		{"free", 0, true}, {"fractional rate", 0.000001, true}, {"largest safe value", 9007199254740991, true},
		{"negative", -1, false}, {"unsafe integer", 9007199254740992, false},
		{"NaN", math.NaN(), false}, {"positive infinity", math.Inf(1), false}, {"negative infinity", math.Inf(-1), false},
	} {
		t.Run(test.name, func(t *testing.T) { assert.Equal(t, test.valid, BillingReferenceNumber(test.value)) })
	}
}
