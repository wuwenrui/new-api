import { api } from "@/lib/api";
import type { Skill, SkillGrantUser, SkillList, SkillWritePayload } from "./types";

export async function fetchAccessibleSkills(query = ""): Promise<SkillList> {
  const response = await api.get<SkillList>("/api/skills/accessible", {
    params: { q: query, page: 1, size: 100 },
    skipBusinessError: true,
  });
  return response.data;
}

export async function fetchSkillGrantUsers(): Promise<SkillGrantUser[]> {
  const response = await api.get<{ items: SkillGrantUser[] }>("/api/skills/admin/users", {
    skipBusinessError: true,
  });
  return response.data.items;
}

export async function createSkill(payload: SkillWritePayload): Promise<Skill> {
  const response = await api.post<Skill>("/api/skills/admin", payload, {
    skipBusinessError: true,
  });
  return response.data;
}

export async function updateSkill(skillId: number, payload: SkillWritePayload): Promise<Skill> {
  const response = await api.put<Skill>(`/api/skills/admin/${skillId}`, payload, {
    skipBusinessError: true,
  });
  return response.data;
}

export async function deleteSkill(skillId: number): Promise<void> {
  await api.delete(`/api/skills/admin/${skillId}`, {
    skipBusinessError: true,
  });
}

export async function downloadSkill(skill: Skill): Promise<void> {
  const response = await api.get<Blob>(
    `/api/skills/accessible/${skill.id}/versions/${skill.latest_version}/download`,
    { responseType: "blob", skipBusinessError: true },
  );
  const url = URL.createObjectURL(response.data);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = skillDownloadFilename(skill);
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function readSkillFileAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function skillDownloadFilename(skill: Pick<Skill, "name" | "latest_version">): string {
  return `${skill.name}-v${skill.latest_version}.zip`;
}
