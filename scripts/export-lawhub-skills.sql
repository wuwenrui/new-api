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
        COALESCE(user_profile.display_name, '') AS author
    FROM skill
    JOIN skillversion
      ON skillversion.skill_id = skill.id
     AND skillversion.version = skill.latest_version
    LEFT JOIN user_profile
      ON user_profile.owner_id = skill.owner_id
) AS exported_skill;
