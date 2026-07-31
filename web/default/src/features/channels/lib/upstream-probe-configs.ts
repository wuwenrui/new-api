/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

/**
 * UpstreamProbeConfigs 系统配置项（service.UpstreamProbeConfigsOptionKey）的
 * 前端读写助手：比价（channel_price_compare）与巡检（pac_price_monitor）
 * 按渠道 base_url 匹配该配置里的探测凭据，实时拉上游 /api/pricing。
 */

export const UPSTREAM_PROBE_CONFIGS_OPTION_KEY = 'UpstreamProbeConfigs'

export interface UpstreamProbeConfig {
  base_url: string
  access_token: string
  user_id: string
}

// 与后端 normalizeUpstreamBaseURL 保持一致：去空白、去尾部斜杠
export function normalizeUpstreamBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

export function parseUpstreamProbeConfigs(raw: string): UpstreamProbeConfig[] {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '[]') return []
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is UpstreamProbeConfig =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as UpstreamProbeConfig).base_url === 'string'
    )
  } catch {
    return []
  }
}

/**
 * 按规范化 base_url 去重 upsert 一条探测凭据，返回格式化后的配置 JSON。
 */
export function upsertUpstreamProbeConfig(
  raw: string,
  next: UpstreamProbeConfig
): string {
  const base = normalizeUpstreamBaseUrl(next.base_url)
  const configs = parseUpstreamProbeConfigs(raw)
  const entry: UpstreamProbeConfig = {
    base_url: base,
    access_token: next.access_token,
    user_id: next.user_id,
  }
  const index = configs.findIndex(
    (c) => normalizeUpstreamBaseUrl(c.base_url) === base
  )
  if (index >= 0) {
    configs[index] = entry
  } else {
    configs.push(entry)
  }
  return JSON.stringify(configs, null, 2)
}

/**
 * 读取某 base_url 已登记的探测凭据（用于保留未修改的字段，如 user_id）。
 */
export function findUpstreamProbeConfig(
  raw: string,
  baseUrl: string
): UpstreamProbeConfig | undefined {
  const base = normalizeUpstreamBaseUrl(baseUrl)
  return parseUpstreamProbeConfigs(raw).find(
    (c) => normalizeUpstreamBaseUrl(c.base_url) === base
  )
}

/**
 * 删除某 base_url 的探测凭据，返回格式化后的配置 JSON；不存在则原样返回。
 */
export function removeUpstreamProbeConfig(raw: string, baseUrl: string): string {
  const base = normalizeUpstreamBaseUrl(baseUrl)
  const configs = parseUpstreamProbeConfigs(raw).filter(
    (c) => normalizeUpstreamBaseUrl(c.base_url) !== base
  )
  return JSON.stringify(configs, null, 2)
}
