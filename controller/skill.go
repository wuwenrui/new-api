package controller

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type SkillResponse struct {
	ID            int    `json:"id"`
	Name          string `json:"name"`
	DisplayName   string `json:"display_name"`
	Description   string `json:"description"`
	Visibility    string `json:"visibility"`
	LatestVersion int    `json:"latest_version"`
	Author        string `json:"author"`
	ContentHash   string `json:"content_hash"`
	UserIDs       []int  `json:"user_ids,omitempty"`
}

type skillWriteRequest struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	Description string `json:"description"`
	Visibility  string `json:"visibility"`
	AuthorName  string `json:"author_name"`
	ContentB64  string `json:"content_b64"`
	UserIDs     []int  `json:"user_ids"`
}

type skillGrantUser struct {
	ID          int    `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

func ListPublicSkills(c *gin.Context) {
	listSkills(c, 0, false)
}

func ListAccessibleSkills(c *gin.Context) {
	role := c.GetInt("role")
	listSkills(c, c.GetInt("id"), role >= common.RoleAdminUser)
}

func listSkills(c *gin.Context, userID int, isAdmin bool) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	skills, total, err := model.SearchVisibleSkills(userID, isAdmin, strings.TrimSpace(c.Query("q")), page, size)
	if err != nil {
		skillError(c, http.StatusInternalServerError, "获取 Skill 列表失败")
		return
	}
	items := make([]SkillResponse, 0, len(skills))
	for i := range skills {
		response := skillResponseFromModel(&skills[i])
		if isAdmin {
			response.UserIDs, err = model.GetSkillUserIDs(skills[i].Id)
			if err != nil {
				skillError(c, http.StatusInternalServerError, "获取 Skill 授权失败")
				return
			}
		}
		items = append(items, response)
	}
	c.JSON(http.StatusOK, gin.H{"items": items, "total": total})
}

func DownloadSkill(c *gin.Context) {
	downloadSkill(c, 0, false)
}

func DownloadAccessibleSkill(c *gin.Context) {
	downloadSkill(c, c.GetInt("id"), c.GetInt("role") >= common.RoleAdminUser)
}

func downloadSkill(c *gin.Context, userID int, isAdmin bool) {
	skillID, version, ok := skillDownloadParams(c)
	if !ok {
		return
	}
	skill, allowed, err := model.GetVisibleSkill(skillID, userID, isAdmin)
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			skillError(c, http.StatusNotFound, "Skill 不存在")
			return
		}
		skillError(c, http.StatusInternalServerError, "读取 Skill 失败")
		return
	}
	if !allowed {
		skillError(c, http.StatusForbidden, "无权查看该 Skill")
		return
	}
	if skill.Version != version {
		skillError(c, http.StatusNotFound, "Skill 版本不存在")
		return
	}
	filename := fmt.Sprintf("%s-v%d.zip", skill.Name, skill.Version)
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	c.Data(http.StatusOK, "application/zip", skill.Content)
}

func AdminCreateSkill(c *gin.Context) {
	var request skillWriteRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		skillError(c, http.StatusBadRequest, "请求格式错误")
		return
	}
	content, hash, err := decodeSkillZip(request.ContentB64)
	if err != nil {
		skillError(c, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateSkillMetadata(&request); err != nil {
		skillError(c, http.StatusBadRequest, err.Error())
		return
	}
	skill := model.Skill{
		Name:        strings.TrimSpace(request.Name),
		DisplayName: strings.TrimSpace(request.DisplayName),
		Description: strings.TrimSpace(request.Description),
		Visibility:  request.Visibility,
		Version:     1,
		Content:     content,
		ContentHash: hash,
		AuthorName:  strings.TrimSpace(request.AuthorName),
	}
	if err := model.CreateSkillWithAccess(&skill, request.UserIDs); err != nil {
		skillError(c, http.StatusConflict, "Skill 名称或编号冲突")
		return
	}
	response := skillResponseFromModel(&skill)
	response.UserIDs, _ = model.GetSkillUserIDs(skill.Id)
	c.JSON(http.StatusCreated, response)
}

func AdminUpdateSkill(c *gin.Context) {
	skillID, err := strconv.Atoi(c.Param("id"))
	if err != nil || skillID <= 0 {
		skillError(c, http.StatusBadRequest, "Skill 编号无效")
		return
	}
	var skill model.Skill
	if err := model.DB.First(&skill, skillID).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			skillError(c, http.StatusNotFound, "Skill 不存在")
			return
		}
		skillError(c, http.StatusInternalServerError, "读取 Skill 失败")
		return
	}
	var request skillWriteRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		skillError(c, http.StatusBadRequest, "请求格式错误")
		return
	}
	if err := validateSkillMetadata(&request); err != nil {
		skillError(c, http.StatusBadRequest, err.Error())
		return
	}
	if request.ContentB64 != "" {
		content, hash, decodeErr := decodeSkillZip(request.ContentB64)
		if decodeErr != nil {
			skillError(c, http.StatusBadRequest, decodeErr.Error())
			return
		}
		if hash != skill.ContentHash {
			skill.Content = content
			skill.ContentHash = hash
			skill.Version++
		}
	}
	skill.Name = strings.TrimSpace(request.Name)
	skill.DisplayName = strings.TrimSpace(request.DisplayName)
	skill.Description = strings.TrimSpace(request.Description)
	skill.Visibility = request.Visibility
	skill.AuthorName = strings.TrimSpace(request.AuthorName)
	if err := model.UpdateSkillWithAccess(&skill, request.UserIDs); err != nil {
		skillError(c, http.StatusConflict, "更新 Skill 失败")
		return
	}
	response := skillResponseFromModel(&skill)
	response.UserIDs, _ = model.GetSkillUserIDs(skill.Id)
	c.JSON(http.StatusOK, response)
}

func AdminDeleteSkill(c *gin.Context) {
	skillID, err := strconv.Atoi(c.Param("id"))
	if err != nil || skillID <= 0 {
		skillError(c, http.StatusBadRequest, "Skill 编号无效")
		return
	}
	if err := model.DeleteSkill(skillID); err != nil {
		skillError(c, http.StatusInternalServerError, "删除 Skill 失败")
		return
	}
	c.Status(http.StatusNoContent)
}

func AdminListSkillGrantUsers(c *gin.Context) {
	var users []model.User
	if err := model.DB.Select("id", "username", "display_name").
		Where("status = ?", common.UserStatusEnabled).
		Order("username ASC").
		Find(&users).Error; err != nil {
		skillError(c, http.StatusInternalServerError, "获取用户列表失败")
		return
	}
	items := make([]skillGrantUser, 0, len(users))
	for i := range users {
		items = append(items, skillGrantUser{ID: users[i].Id, Username: users[i].Username, DisplayName: users[i].DisplayName})
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

func validateSkillMetadata(request *skillWriteRequest) error {
	name := strings.TrimSpace(request.Name)
	if name == "" || len(name) > 128 || strings.ContainsAny(name, "/\\") || name == "." || name == ".." {
		return fmt.Errorf("Skill 名称无效")
	}
	if strings.TrimSpace(request.DisplayName) == "" || len(request.DisplayName) > 255 {
		return fmt.Errorf("Skill 显示名无效")
	}
	if request.Visibility != model.SkillVisibilityPublic && request.Visibility != model.SkillVisibilityPrivate {
		return fmt.Errorf("Skill 可见状态无效")
	}
	return nil
}

func decodeSkillZip(contentB64 string) ([]byte, string, error) {
	content, err := base64.StdEncoding.DecodeString(contentB64)
	if err != nil {
		return nil, "", fmt.Errorf("Skill ZIP 内容无效")
	}
	hash, err := model.ValidateSkillContent(content)
	if err != nil {
		return nil, "", err
	}
	return content, hash, nil
}

func skillDownloadParams(c *gin.Context) (int, int, bool) {
	skillID, skillErr := strconv.Atoi(c.Param("id"))
	version, versionErr := strconv.Atoi(c.Param("version"))
	if skillErr != nil || versionErr != nil || skillID <= 0 || version <= 0 {
		skillError(c, http.StatusBadRequest, "Skill 编号或版本无效")
		return 0, 0, false
	}
	return skillID, version, true
}

func skillResponseFromModel(skill *model.Skill) SkillResponse {
	return SkillResponse{
		ID:            skill.Id,
		Name:          skill.Name,
		DisplayName:   skill.DisplayName,
		Description:   skill.Description,
		Visibility:    skill.Visibility,
		LatestVersion: skill.Version,
		Author:        skill.AuthorName,
		ContentHash:   skill.ContentHash,
	}
}

func skillError(c *gin.Context, status int, message string) {
	c.JSON(status, gin.H{"detail": message})
}
