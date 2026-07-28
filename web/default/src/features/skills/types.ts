export type SkillVisibility = "public" | "private";

export type Skill = {
  id: number;
  name: string;
  display_name: string;
  description: string;
  visibility: SkillVisibility;
  latest_version: number;
  author: string;
  content_hash: string;
  user_ids?: number[];
};

export type SkillList = {
  items: Skill[];
  total: number;
};

export type SkillGrantUser = {
  id: number;
  username: string;
  display_name: string;
};

export type SkillWritePayload = {
  name: string;
  display_name: string;
  description: string;
  visibility: SkillVisibility;
  author_name: string;
  content_b64: string;
  user_ids: number[];
};
