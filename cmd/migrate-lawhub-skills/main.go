package main

import (
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"gorm.io/gorm"
)

type lawhubSkillRecord struct {
	ID               int      `json:"id"`
	Name             string   `json:"name"`
	DisplayName      string   `json:"display_name"`
	Description      string   `json:"description"`
	Visibility       string   `json:"visibility"`
	LatestVersion    int      `json:"latest_version"`
	ContentB64       string   `json:"content_b64"`
	ContentHash      string   `json:"content_hash"`
	Author           string   `json:"author"`
	AllowedUsernames []string `json:"allowed_usernames"`
}

type ImportItem struct {
	ID          int    `json:"id"`
	Name        string `json:"name"`
	ContentHash string `json:"content_hash"`
}

type ImportReport struct {
	Total             int          `json:"total"`
	Public            int          `json:"public"`
	Private           int          `json:"private"`
	SkippedUserAccess int          `json:"skipped_user_access"`
	Items             []ImportItem `json:"items"`
}

func main() {
	inputPath := flag.String("input", "", "lawhub 当前 Skill 版本 JSON 文件")
	flag.Parse()
	if strings.TrimSpace(*inputPath) == "" {
		fmt.Fprintln(os.Stderr, "必须通过 -input 指定导入文件")
		os.Exit(2)
	}
	input, err := os.Open(*inputPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "打开导入文件失败: %v\n", err)
		os.Exit(1)
	}
	defer input.Close()
	if err := model.InitDB(); err != nil {
		fmt.Fprintf(os.Stderr, "连接模型站点数据库失败: %v\n", err)
		os.Exit(1)
	}
	report, err := ImportLawhubSkills(model.DB, input)
	if err != nil {
		fmt.Fprintf(os.Stderr, "迁移失败: %v\n", err)
		os.Exit(1)
	}
	output, err := common.Marshal(report)
	if err != nil {
		fmt.Fprintf(os.Stderr, "生成迁移报告失败: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(string(output))
}

func ImportLawhubSkills(db *gorm.DB, reader io.Reader) (ImportReport, error) {
	var records []lawhubSkillRecord
	if err := common.DecodeJson(reader, &records); err != nil {
		return ImportReport{}, fmt.Errorf("解析导入文件失败: %w", err)
	}
	if len(records) == 0 {
		return ImportReport{}, fmt.Errorf("导入文件中没有 Skill")
	}

	skills := make([]model.Skill, 0, len(records))
	accessUsernames := make([][]string, 0, len(records))
	report := ImportReport{Total: len(records), Items: make([]ImportItem, 0, len(records))}
	for _, record := range records {
		skill, err := skillFromLawhubRecord(record)
		if err != nil {
			return ImportReport{}, fmt.Errorf("Skill %d (%s): %w", record.ID, record.Name, err)
		}
		usernames := normalizeAllowedUsernames(record.AllowedUsernames)
		if skill.Visibility == model.SkillVisibilityPrivate && len(usernames) == 0 {
			return ImportReport{}, fmt.Errorf("Skill %d (%s): 私有 Skill 没有可访问用户", record.ID, record.Name)
		}
		skills = append(skills, skill)
		accessUsernames = append(accessUsernames, usernames)
		report.Items = append(report.Items, ImportItem{
			ID:          skill.Id,
			Name:        skill.Name,
			ContentHash: skill.ContentHash,
		})
		if skill.Visibility == model.SkillVisibilityPublic {
			report.Public++
		} else {
			report.Private++
		}
	}

	err := db.Transaction(func(tx *gorm.DB) error {
		for i := range skills {
			if err := tx.Create(&skills[i]).Error; err != nil {
				return fmt.Errorf("写入 Skill %d (%s) 失败: %w", skills[i].Id, skills[i].Name, err)
			}
			for _, username := range accessUsernames[i] {
				var user model.User
				err := tx.Select("id").Where("username = ?", username).Take(&user).Error
				if errors.Is(err, gorm.ErrRecordNotFound) {
					report.SkippedUserAccess++
					continue
				}
				if err != nil {
					return fmt.Errorf("查询 Skill %d (%s) 的可访问用户 %s 失败: %w", skills[i].Id, skills[i].Name, username, err)
				}
				access := model.SkillUserAccess{SkillID: skills[i].Id, UserID: user.Id}
				if err := tx.Create(&access).Error; err != nil {
					return fmt.Errorf("写入 Skill %d (%s) 的用户权限失败: %w", skills[i].Id, skills[i].Name, err)
				}
			}
		}
		return resetPostgresSkillSequence(tx)
	})
	if err != nil {
		return ImportReport{}, err
	}
	return report, nil
}

func normalizeAllowedUsernames(usernames []string) []string {
	normalized := make([]string, 0, len(usernames))
	seen := make(map[string]struct{}, len(usernames))
	for _, username := range usernames {
		username = strings.TrimSpace(username)
		key := strings.ToLower(username)
		if key == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		normalized = append(normalized, username)
	}
	return normalized
}

func resetPostgresSkillSequence(tx *gorm.DB) error {
	if tx.Dialector.Name() != "postgres" {
		return nil
	}
	return tx.Exec(`
		SELECT setval(
			pg_get_serial_sequence('skills', 'id'),
			COALESCE(MAX(id), 1),
			COUNT(*) > 0
		)
		FROM skills
	`).Error
}

func skillFromLawhubRecord(record lawhubSkillRecord) (model.Skill, error) {
	name := strings.TrimSpace(record.Name)
	displayName := strings.TrimSpace(record.DisplayName)
	if record.ID <= 0 || name == "" || displayName == "" || record.LatestVersion <= 0 {
		return model.Skill{}, fmt.Errorf("编号、名称、显示名或版本无效")
	}
	if len(name) > 128 || strings.ContainsAny(name, "/\\") || name == "." || name == ".." {
		return model.Skill{}, fmt.Errorf("名称无效")
	}
	if record.Visibility != model.SkillVisibilityPublic && record.Visibility != model.SkillVisibilityPrivate {
		return model.Skill{}, fmt.Errorf("公开/私有状态无效")
	}
	content, err := base64.StdEncoding.DecodeString(record.ContentB64)
	if err != nil {
		return model.Skill{}, fmt.Errorf("ZIP base64 无效")
	}
	contentHash, err := model.ValidateSkillContent(content)
	if err != nil {
		return model.Skill{}, err
	}
	if !strings.EqualFold(contentHash, strings.TrimSpace(record.ContentHash)) {
		return model.Skill{}, fmt.Errorf("内容哈希不一致")
	}
	return model.Skill{
		Id:          record.ID,
		Name:        name,
		DisplayName: displayName,
		Description: strings.TrimSpace(record.Description),
		Visibility:  record.Visibility,
		Version:     record.LatestVersion,
		Content:     content,
		ContentHash: contentHash,
		AuthorName:  strings.TrimSpace(record.Author),
	}, nil
}
