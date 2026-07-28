package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestImportLawhubSkillsPreservesCurrentVersionAndHash(t *testing.T) {
	db := prepareImportDB(t)
	content := importTestZip(t, "current")
	input := marshalImportRecords(t, []map[string]any{
		importRecordMap(7, "case-review", "private", 4, content),
		importRecordMap(8, "contract-review", "public", 2, content),
	})

	report, err := ImportLawhubSkills(db, bytes.NewReader(input))
	require.NoError(t, err)
	require.Equal(t, 2, report.Total)
	require.Equal(t, 1, report.Public)
	require.Equal(t, 1, report.Private)
	require.Equal(t, []ImportItem{
		{ID: 7, Name: "case-review", ContentHash: sha256Hex(content)},
		{ID: 8, Name: "contract-review", ContentHash: sha256Hex(content)},
	}, report.Items)

	var skill model.Skill
	require.NoError(t, db.First(&skill, 7).Error)
	require.Equal(t, "case-review", skill.Name)
	require.Equal(t, 4, skill.Version)
	require.Equal(t, content, skill.Content)
	require.Equal(t, sha256Hex(content), skill.ContentHash)
}

func TestImportLawhubSkillsRollsBackWholeBatchOnConflict(t *testing.T) {
	db := prepareImportDB(t)
	content := importTestZip(t, "current")
	input := marshalImportRecords(t, []map[string]any{
		importRecordMap(7, "case-review", "private", 4, content),
		importRecordMap(7, "duplicate-id", "public", 1, content),
	})

	_, err := ImportLawhubSkills(db, bytes.NewReader(input))
	require.Error(t, err)
	var count int64
	require.NoError(t, db.Model(&model.Skill{}).Count(&count).Error)
	require.Zero(t, count)
}

func TestImportLawhubSkillsRejectsHashMismatchBeforeWriting(t *testing.T) {
	db := prepareImportDB(t)
	content := importTestZip(t, "current")
	record := importRecordMap(7, "case-review", "private", 4, content)
	record["content_hash"] = "wrong"

	_, err := ImportLawhubSkills(db, bytes.NewReader(marshalImportRecords(t, []map[string]any{record})))
	require.ErrorContains(t, err, "哈希")
	var count int64
	require.NoError(t, db.Model(&model.Skill{}).Count(&count).Error)
	require.Zero(t, count)
}

func prepareImportDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.Skill{}, &model.SkillUserAccess{}))
	return db
}

func importRecordMap(id int, name, visibility string, version int, content []byte) map[string]any {
	return map[string]any{
		"id":             id,
		"name":           name,
		"display_name":   name,
		"description":    "description",
		"visibility":     visibility,
		"latest_version": version,
		"content_b64":    base64.StdEncoding.EncodeToString(content),
		"content_hash":   sha256Hex(content),
		"author":         "旧作者",
	}
}

func marshalImportRecords(t *testing.T, records []map[string]any) []byte {
	t.Helper()
	data, err := common.Marshal(records)
	require.NoError(t, err)
	return data
}

func importTestZip(t *testing.T, content string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	file, err := writer.Create("SKILL.md")
	require.NoError(t, err)
	_, err = file.Write([]byte(content))
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	return buffer.Bytes()
}

func sha256Hex(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}
