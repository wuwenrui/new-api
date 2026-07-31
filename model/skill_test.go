package model

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
)

func prepareSkillTest(t *testing.T) {
	t.Helper()
	require.NoError(t, DB.AutoMigrate(&User{}, &Skill{}, &SkillUserAccess{}))
	require.NoError(t, DB.Exec("DELETE FROM skill_user_access").Error)
	require.NoError(t, DB.Exec("DELETE FROM skills").Error)
	require.NoError(t, DB.Exec("DELETE FROM users").Error)
}

func TestListVisibleSkillsHonorsPublicAndExplicitUserAccess(t *testing.T) {
	prepareSkillTest(t)

	user := User{Username: "skill-reader", Password: "unused", Status: 1}
	require.NoError(t, DB.Create(&user).Error)
	publicSkill := Skill{Name: "public-skill", DisplayName: "公开技能", Visibility: SkillVisibilityPublic, Version: 1}
	privateSkill := Skill{Name: "private-skill", DisplayName: "私有技能", Visibility: SkillVisibilityPrivate, Version: 1}
	hiddenSkill := Skill{Name: "hidden-skill", DisplayName: "未授权技能", Visibility: SkillVisibilityPrivate, Version: 1}
	require.NoError(t, DB.Create(&publicSkill).Error)
	require.NoError(t, DB.Create(&privateSkill).Error)
	require.NoError(t, DB.Create(&hiddenSkill).Error)
	require.NoError(t, ReplaceSkillUserAccess(privateSkill.Id, []int{user.Id}))

	visible, err := ListVisibleSkills(user.Id, false)
	require.NoError(t, err)
	require.ElementsMatch(t, []string{"public-skill", "private-skill"}, skillNames(visible))

	adminVisible, err := ListVisibleSkills(user.Id, true)
	require.NoError(t, err)
	require.ElementsMatch(t, []string{"public-skill", "private-skill", "hidden-skill"}, skillNames(adminVisible))
}

func TestGetVisibleSkillRejectsUnlistedPrivateUser(t *testing.T) {
	prepareSkillTest(t)

	privateSkill := Skill{Name: "private-skill", DisplayName: "私有技能", Visibility: SkillVisibilityPrivate, Version: 3}
	require.NoError(t, DB.Create(&privateSkill).Error)

	_, allowed, err := GetVisibleSkill(privateSkill.Id, 99, false)
	require.NoError(t, err)
	require.False(t, allowed)

	got, allowed, err := GetVisibleSkill(privateSkill.Id, 99, true)
	require.NoError(t, err)
	require.True(t, allowed)
	require.Equal(t, 3, got.Version)
}

func TestReplaceSkillUserAccessReplacesOldSelection(t *testing.T) {
	prepareSkillTest(t)

	skill := Skill{Name: "private-skill", DisplayName: "私有技能", Visibility: SkillVisibilityPrivate, Version: 1}
	require.NoError(t, DB.Create(&skill).Error)
	require.NoError(t, ReplaceSkillUserAccess(skill.Id, []int{2, 3, 3}))
	require.NoError(t, ReplaceSkillUserAccess(skill.Id, []int{4}))

	userIDs, err := GetSkillUserIDs(skill.Id)
	require.NoError(t, err)
	require.Equal(t, []int{4}, userIDs)
}

func skillNames(skills []Skill) []string {
	names := make([]string, 0, len(skills))
	for _, skill := range skills {
		names = append(names, skill.Name)
	}
	return names
}

func TestSkillTableNameIsStable(t *testing.T) {
	require.Equal(t, "skills", fmt.Sprintf("%s", Skill{}.TableName()))
}
