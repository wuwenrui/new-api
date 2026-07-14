package model

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestGetModelImageInputCapabilities(t *testing.T) {
	require.NoError(t, DB.AutoMigrate(&Model{}))
	require.NoError(t, DB.Exec("DELETE FROM models").Error)
	t.Cleanup(func() {
		require.NoError(t, DB.Exec("DELETE FROM models").Error)
	})

	require.NoError(t, DB.Create(&[]Model{
		{ModelName: "vision-model", Tags: "chat; Vision"},
		{ModelName: "text-model", Tags: "chat,tools"},
		{ModelName: "untagged-model", Tags: "  | ; "},
	}).Error)

	capabilities, err := GetModelImageInputCapabilities([]string{
		"vision-model", "text-model", "untagged-model", "missing-model",
	})

	require.NoError(t, err)
	require.Equal(t, map[string]bool{
		"vision-model": true,
		"text-model":   false,
	}, capabilities)
}
