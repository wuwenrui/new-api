package model

import (
	"sort"

	"gorm.io/gorm"
)

const (
	SkillVisibilityPublic  = "public"
	SkillVisibilityPrivate = "private"
)

type Skill struct {
	Id          int    `json:"id" gorm:"primaryKey;autoIncrement"`
	Name        string `json:"name" gorm:"size:128;uniqueIndex;not null"`
	DisplayName string `json:"display_name" gorm:"size:255;not null"`
	Description string `json:"description" gorm:"type:text"`
	Visibility  string `json:"visibility" gorm:"size:16;not null;default:private;index"`
	Version     int    `json:"version" gorm:"not null;default:1"`
	Content     []byte `json:"-" gorm:"not null"`
	ContentHash string `json:"content_hash" gorm:"size:64;not null"`
	AuthorName  string `json:"author_name" gorm:"size:255"`
	CreatedAt   int64  `json:"created_at" gorm:"autoCreateTime"`
	UpdatedAt   int64  `json:"updated_at" gorm:"autoUpdateTime"`
}

func (Skill) TableName() string {
	return "skills"
}

type SkillUserAccess struct {
	SkillID int `json:"skill_id" gorm:"primaryKey;not null;index"`
	UserID  int `json:"user_id" gorm:"primaryKey;not null;index"`
}

func (SkillUserAccess) TableName() string {
	return "skill_user_access"
}

func ListVisibleSkills(userID int, isAdmin bool) ([]Skill, error) {
	var skills []Skill
	query := DB.Model(&Skill{})
	if !isAdmin {
		accessibleIDs := DB.Model(&SkillUserAccess{}).
			Select("skill_id").
			Where("user_id = ?", userID)
		query = query.Where("visibility = ? OR id IN (?)", SkillVisibilityPublic, accessibleIDs)
	}
	err := query.Order("updated_at DESC, id DESC").Find(&skills).Error
	return skills, err
}

func SearchVisibleSkills(userID int, isAdmin bool, queryText string, page, size int) ([]Skill, int64, error) {
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = 20
	}
	if size > 100 {
		size = 100
	}

	query := DB.Model(&Skill{})
	if !isAdmin {
		accessibleIDs := DB.Model(&SkillUserAccess{}).
			Select("skill_id").
			Where("user_id = ?", userID)
		query = query.Where("visibility = ? OR id IN (?)", SkillVisibilityPublic, accessibleIDs)
	}
	if queryText != "" {
		pattern := "%" + queryText + "%"
		query = query.Where("name LIKE ? OR display_name LIKE ? OR description LIKE ?", pattern, pattern, pattern)
	}

	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var skills []Skill
	err := query.Order("updated_at DESC, id DESC").
		Offset((page - 1) * size).
		Limit(size).
		Find(&skills).Error
	return skills, total, err
}

func GetVisibleSkill(skillID, userID int, isAdmin bool) (*Skill, bool, error) {
	var skill Skill
	if err := DB.First(&skill, skillID).Error; err != nil {
		return nil, false, err
	}
	if isAdmin || skill.Visibility == SkillVisibilityPublic {
		return &skill, true, nil
	}

	var count int64
	err := DB.Model(&SkillUserAccess{}).
		Where("skill_id = ? AND user_id = ?", skillID, userID).
		Count(&count).Error
	if err != nil {
		return nil, false, err
	}
	return &skill, count > 0, nil
}

func ReplaceSkillUserAccess(skillID int, userIDs []int) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		return replaceSkillUserAccess(tx, skillID, userIDs)
	})
}

func CreateSkillWithAccess(skill *Skill, userIDs []int) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(skill).Error; err != nil {
			return err
		}
		return replaceSkillUserAccess(tx, skill.Id, userIDs)
	})
}

func UpdateSkillWithAccess(skill *Skill, userIDs []int) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Save(skill).Error; err != nil {
			return err
		}
		return replaceSkillUserAccess(tx, skill.Id, userIDs)
	})
}

func DeleteSkill(skillID int) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("skill_id = ?", skillID).Delete(&SkillUserAccess{}).Error; err != nil {
			return err
		}
		return tx.Delete(&Skill{}, skillID).Error
	})
}

func replaceSkillUserAccess(tx *gorm.DB, skillID int, userIDs []int) error {
	uniqueUserIDs := make([]int, 0, len(userIDs))
	seen := make(map[int]struct{}, len(userIDs))
	for _, userID := range userIDs {
		if userID <= 0 {
			continue
		}
		if _, exists := seen[userID]; exists {
			continue
		}
		seen[userID] = struct{}{}
		uniqueUserIDs = append(uniqueUserIDs, userID)
	}
	if err := tx.Where("skill_id = ?", skillID).Delete(&SkillUserAccess{}).Error; err != nil {
		return err
	}
	for _, userID := range uniqueUserIDs {
		if err := tx.Create(&SkillUserAccess{SkillID: skillID, UserID: userID}).Error; err != nil {
			return err
		}
	}
	return nil
}

func GetSkillUserIDs(skillID int) ([]int, error) {
	var userIDs []int
	err := DB.Model(&SkillUserAccess{}).
		Where("skill_id = ?", skillID).
		Pluck("user_id", &userIDs).Error
	sort.Ints(userIDs)
	return userIDs, err
}
