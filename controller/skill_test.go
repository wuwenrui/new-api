package controller

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func prepareSkillControllerTest(t *testing.T) {
	t.Helper()
	originalDB := model.DB
	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", t.Name())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Skill{}, &model.SkillUserAccess{}))
	model.DB = db
	t.Cleanup(func() { model.DB = originalDB })
}

func TestSkillEndpointsEnforceVisibilityAndPreservePublicContract(t *testing.T) {
	prepareSkillControllerTest(t)
	gin.SetMode(gin.TestMode)

	reader := model.User{Username: "reader", Password: "unused", Status: common.UserStatusEnabled, Role: common.RoleCommonUser}
	require.NoError(t, model.DB.Create(&reader).Error)
	publicSkill := model.Skill{Name: "public", DisplayName: "公开", Visibility: model.SkillVisibilityPublic, Version: 1, Content: testSkillZip(t, "public"), ContentHash: "hash-public"}
	privateSkill := model.Skill{Name: "private", DisplayName: "私有", Visibility: model.SkillVisibilityPrivate, Version: 2, Content: testSkillZip(t, "private"), ContentHash: "hash-private"}
	require.NoError(t, model.DB.Create(&publicSkill).Error)
	require.NoError(t, model.DB.Create(&privateSkill).Error)
	require.NoError(t, model.ReplaceSkillUserAccess(privateSkill.Id, []int{reader.Id}))

	router := gin.New()
	router.GET("/api/skills/public", ListPublicSkills)
	router.GET("/api/skills/:id/versions/:version/download", DownloadSkill)
	router.GET("/api/skills/accessible", func(c *gin.Context) {
		c.Set("id", reader.Id)
		c.Set("role", common.RoleCommonUser)
		ListAccessibleSkills(c)
	})

	publicList := performSkillRequest(t, router, http.MethodGet, "/api/skills/public?page=1&size=20", nil)
	require.Equal(t, http.StatusOK, publicList.Code)
	var publicBody struct {
		Items []SkillResponse `json:"items"`
		Total int64           `json:"total"`
	}
	require.NoError(t, common.Unmarshal(publicList.Body.Bytes(), &publicBody))
	require.Equal(t, int64(1), publicBody.Total)
	require.Equal(t, "public", publicBody.Items[0].Name)
	require.Equal(t, 1, publicBody.Items[0].LatestVersion)

	accessible := performSkillRequest(t, router, http.MethodGet, "/api/skills/accessible", nil)
	require.Equal(t, http.StatusOK, accessible.Code)
	var accessibleBody struct {
		Items []SkillResponse `json:"items"`
		Total int64           `json:"total"`
	}
	require.NoError(t, common.Unmarshal(accessible.Body.Bytes(), &accessibleBody))
	require.Equal(t, int64(2), accessibleBody.Total)

	forbidden := performSkillRequest(t, router, http.MethodGet, fmt.Sprintf("/api/skills/%d/versions/2/download", privateSkill.Id), nil)
	require.Equal(t, http.StatusForbidden, forbidden.Code)

	authorizedRouter := gin.New()
	authorizedRouter.GET("/api/skills/accessible/:id/versions/:version/download", func(c *gin.Context) {
		c.Set("id", reader.Id)
		c.Set("role", common.RoleCommonUser)
		DownloadAccessibleSkill(c)
	})
	download := performSkillRequest(t, authorizedRouter, http.MethodGet, fmt.Sprintf("/api/skills/accessible/%d/versions/2/download", privateSkill.Id), nil)
	require.Equal(t, http.StatusOK, download.Code)
	require.Equal(t, "application/zip", download.Header().Get("Content-Type"))
}

func TestAdminCreateAndUpdateSkillValidatesZipAndIncrementsVersion(t *testing.T) {
	prepareSkillControllerTest(t)
	gin.SetMode(gin.TestMode)

	router := gin.New()
	router.POST("/api/skills/admin", AdminCreateSkill)
	router.PUT("/api/skills/admin/:id", AdminUpdateSkill)

	invalid := skillWriteJSON(t, "broken", "not a zip", model.SkillVisibilityPrivate, []int{3})
	invalidResponse := performSkillRequest(t, router, http.MethodPost, "/api/skills/admin", invalid)
	require.Equal(t, http.StatusBadRequest, invalidResponse.Code)

	createBody := skillWriteJSON(t, "case-review", string(testSkillZip(t, "v1")), model.SkillVisibilityPrivate, []int{3, 4})
	created := performSkillRequest(t, router, http.MethodPost, "/api/skills/admin", createBody)
	require.Equal(t, http.StatusCreated, created.Code)
	var createdSkill SkillResponse
	require.NoError(t, common.Unmarshal(created.Body.Bytes(), &createdSkill))
	require.Equal(t, 1, createdSkill.LatestVersion)

	updateBody := skillWriteJSON(t, "case-review", string(testSkillZip(t, "v2")), model.SkillVisibilityPublic, nil)
	updated := performSkillRequest(t, router, http.MethodPut, fmt.Sprintf("/api/skills/admin/%d", createdSkill.ID), updateBody)
	require.Equal(t, http.StatusOK, updated.Code)
	var updatedSkill SkillResponse
	require.NoError(t, common.Unmarshal(updated.Body.Bytes(), &updatedSkill))
	require.Equal(t, 2, updatedSkill.LatestVersion)
	require.Equal(t, model.SkillVisibilityPublic, updatedSkill.Visibility)
}

func performSkillRequest(t *testing.T, router http.Handler, method, path string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func skillWriteJSON(t *testing.T, name, content, visibility string, userIDs []int) []byte {
	t.Helper()
	body, err := common.Marshal(map[string]any{
		"name":         name,
		"display_name": name,
		"description":  "description",
		"visibility":   visibility,
		"author_name":  "管理员",
		"content_b64":  base64.StdEncoding.EncodeToString([]byte(content)),
		"user_ids":     userIDs,
	})
	require.NoError(t, err)
	return body
}

func testSkillZip(t *testing.T, content string) []byte {
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
