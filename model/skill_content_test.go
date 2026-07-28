package model

import (
	"archive/zip"
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func buildSkillContentZip(t *testing.T, entries map[string][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, content := range entries {
		file, err := writer.Create(name)
		require.NoError(t, err)
		_, err = file.Write(content)
		require.NoError(t, err)
	}
	require.NoError(t, writer.Close())
	return buffer.Bytes()
}

func TestSkillContentPreviewListsAndReadsText(t *testing.T) {
	content := buildSkillContentZip(t, map[string][]byte{
		"docs/":         {},
		"docs/guide.md": []byte("使用说明"),
		"SKILL.md":      []byte("# 主文档"),
	})

	entries, err := ListSkillContentEntries(content)
	require.NoError(t, err)
	require.Equal(t, []SkillContentEntry{
		{Path: "SKILL.md", Size: 11, IsDir: false},
		{Path: "docs/", Size: 0, IsDir: true},
		{Path: "docs/guide.md", Size: 12, IsDir: false},
	}, entries)

	file, err := ReadSkillContentEntry(content, "docs/guide.md", 512*1024)
	require.NoError(t, err)
	require.Equal(t, "使用说明", file.Content)
	require.Equal(t, uint64(12), file.Size)
	require.False(t, file.Truncated)
}

func TestSkillContentPreviewTruncatesAtUtf8Boundary(t *testing.T) {
	content := buildSkillContentZip(t, map[string][]byte{
		"big.md": []byte(strings.Repeat("法", 200_000)),
	})

	file, err := ReadSkillContentEntry(content, "big.md", 512*1024)
	require.NoError(t, err)
	require.True(t, file.Truncated)
	require.Equal(t, uint64(600_000), file.Size)
	require.Len(t, []byte(file.Content), 524_286)
}

func TestSkillContentPreviewRejectsMissingDirectoryAndBinary(t *testing.T) {
	content := buildSkillContentZip(t, map[string][]byte{
		"docs/":    {},
		"binary":   {0xff, 0xfe, 0xfd},
		"SKILL.md": []byte("text"),
	})

	_, err := ReadSkillContentEntry(content, "missing.md", 512*1024)
	require.ErrorIs(t, err, ErrSkillContentEntryNotFound)

	_, err = ReadSkillContentEntry(content, "docs/", 512*1024)
	require.ErrorIs(t, err, ErrSkillContentEntryNotFound)

	_, err = ReadSkillContentEntry(content, "binary", 512*1024)
	require.True(t, errors.Is(err, ErrSkillContentBinary))
}
