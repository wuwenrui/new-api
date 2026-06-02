package model

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestMergeModelEndpointTypesKeepsDefaultAndCustomEndpoints(t *testing.T) {
	endpoints := mergeModelEndpointTypes(
		[]string{"anthropic", "openai"},
		`{"openai":{"path":"/v1/chat/completions","method":"POST"}}`,
	)

	require.Equal(t, []string{"anthropic", "openai"}, endpoints)
}

func TestMergeModelEndpointTypesAddsCustomEndpointsWhenNoDefaultExists(t *testing.T) {
	endpoints := mergeModelEndpointTypes(
		nil,
		`{"openai":{"path":"/v1/chat/completions","method":"POST"}}`,
	)

	require.Equal(t, []string{"openai"}, endpoints)
}
