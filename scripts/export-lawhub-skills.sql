SELECT COALESCE(json_agg(exported_skill ORDER BY exported_skill.id), '[]'::json)
FROM (
    SELECT
        skill.id,
        skill.name,
        skill.display_name,
        skill.description,
        skill.visibility,
        skill.latest_version,
        encode(skillversion.content, 'base64') AS content_b64,
        skillversion.content_hash,
        COALESCE(owner_profile.display_name, '') AS author,
        COALESCE(
            (
                SELECT json_agg(access_user.username ORDER BY access_user.username)
                FROM (
                    SELECT owner_profile.username
                    WHERE owner_profile.username IS NOT NULL
                      AND owner_profile.username <> ''
                    UNION
                    SELECT role_profile.username
                    FROM skill_role
                    JOIN user_role
                      ON user_role.role_id = skill_role.role_id
                    JOIN user_profile AS role_profile
                      ON role_profile.id = user_role.user_id
                    WHERE skill_role.skill_id = skill.id
                ) AS access_user
            ),
            '[]'::json
        ) AS allowed_usernames
    FROM skill
    JOIN skillversion
      ON skillversion.skill_id = skill.id
     AND skillversion.version = skill.latest_version
    LEFT JOIN user_profile AS owner_profile
      ON owner_profile.owner_id = skill.owner_id
) AS exported_skill;
