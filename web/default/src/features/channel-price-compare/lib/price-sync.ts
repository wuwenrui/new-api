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
// ----------------------------------------------------------------------------
// Selling-price sync logic
// Mirrors the backend math in service/pac_price_monitor.go: ratio 1 anchors at
// $2 / 1M tokens and the displayed selling price multiplies in the group ratio,
// i.e. sellUsdPer1M = modelRatio * groupRatio * RATIO_USD_PER_MILLION.
// ----------------------------------------------------------------------------

import type { PriceCompareChannel } from '../types'

const DEFAULT_QUOTA_PER_UNIT = 500_000
export const MAX_TARGET_MARGIN_PERCENT = 95

export type UpstreamCostBasis = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  source: 'manual' | 'detected'
}

export type SyncRatioPlan = {
  modelRatio: number
  completionRatio: number
  completionRatioLocked: boolean
  cacheRatio: number
  createCacheRatio: number
  sellInput: number
  sellOutput: number
}

export type PricingSyncRequest = {
  model_name: string
  model_ratio: number
  completion_ratio?: number
  cache_ratio: number
  create_cache_ratio: number
}

// Prefer the live detected upstream price when available; it is fresher than
// the manually maintained purchase price whenever the two drift apart.
export function resolveSyncBasis(
  channel: PriceCompareChannel
): UpstreamCostBasis | null {
  if (channel.status !== 'ok') return null
  if (channel.detected_available) {
    return {
      input: channel.detected_input,
      output: channel.detected_output,
      cacheRead: channel.detected_cache_read,
      cacheWrite: channel.detected_cache_write,
      source: 'detected',
    }
  }
  return {
    input: channel.upstream_input,
    output: channel.upstream_output,
    cacheRead: channel.upstream_cache_read,
    cacheWrite: channel.upstream_cache_write,
    source: 'manual',
  }
}

function ceilRatio(value: number): number {
  return Math.ceil(value * 1e6) / 1e6
}

// Selling price = cost / (1 - margin). When the backend locks a model's
// completion ratio, the input ratio is raised enough to keep both input and
// output at or above the requested margin.
export function parseTargetMargin(raw: string): number | null {
  if (raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_TARGET_MARGIN_PERCENT
    ? value
    : null
}

export function computeSyncRatios(
  cost: UpstreamCostBasis,
  marginPercent: number,
  groupRatio: number,
  lockedCompletionRatio?: number,
  quotaPerUnit = DEFAULT_QUOTA_PER_UNIT
): SyncRatioPlan | null {
  if (
    !Number.isFinite(cost.input) ||
    cost.input <= 0 ||
    !Number.isFinite(cost.output) ||
    cost.output < 0 ||
    !Number.isFinite(cost.cacheRead) ||
    cost.cacheRead < 0 ||
    !Number.isFinite(cost.cacheWrite) ||
    cost.cacheWrite < 0
  ) {
    return null
  }
  if (
    !Number.isFinite(marginPercent) ||
    marginPercent < 0 ||
    marginPercent >= MAX_TARGET_MARGIN_PERCENT
  ) {
    return null
  }
  if (!Number.isFinite(groupRatio) || groupRatio <= 0) {
    return null
  }
  if (!Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) {
    return null
  }
  const marginDivisor = 1 - marginPercent / 100
  const requestedInput = cost.input / marginDivisor
  const requestedOutput = cost.output / marginDivisor
  let completionRatio = ceilRatio(cost.output / cost.input)
  let completionRatioLocked = false
  let requiredInput = requestedInput
  if (lockedCompletionRatio !== undefined) {
    if (
      !Number.isFinite(lockedCompletionRatio) ||
      lockedCompletionRatio < 0 ||
      (lockedCompletionRatio === 0 && cost.output > 0)
    ) {
      return null
    }
    completionRatio = lockedCompletionRatio
    completionRatioLocked = true
    if (completionRatio > 0) {
      requiredInput = Math.max(
        requestedInput,
        requestedOutput / completionRatio
      )
    }
  }

  const usdPerMillion = 1_000_000 / quotaPerUnit
  const modelRatio = ceilRatio(requiredInput / (usdPerMillion * groupRatio))
  const sellInput = modelRatio * usdPerMillion * groupRatio
  const sellOutput = sellInput * completionRatio
  const cacheRatio = ceilRatio(cost.cacheRead / marginDivisor / sellInput)
  const createCacheRatio = ceilRatio(
    cost.cacheWrite / marginDivisor / sellInput
  )
  if (
    !Number.isFinite(modelRatio) ||
    modelRatio <= 0 ||
    !Number.isFinite(completionRatio) ||
    !Number.isFinite(sellInput) ||
    !Number.isFinite(sellOutput) ||
    !Number.isFinite(cacheRatio) ||
    !Number.isFinite(createCacheRatio)
  ) {
    return null
  }
  return {
    modelRatio,
    completionRatio,
    completionRatioLocked,
    cacheRatio,
    createCacheRatio,
    sellInput,
    sellOutput,
  }
}

export function buildSyncRequest(
  modelName: string,
  plan: SyncRatioPlan
): PricingSyncRequest {
  return {
    model_name: modelName,
    model_ratio: plan.modelRatio,
    ...(plan.completionRatioLocked
      ? {}
      : { completion_ratio: plan.completionRatio }),
    cache_ratio: plan.cacheRatio,
    create_cache_ratio: plan.createCacheRatio,
  }
}

export type CompletionRatioMeta = {
  ratio: number
  locked: boolean
}

export function parseCompletionRatioMeta(
  raw: string | undefined
): Record<string, CompletionRatioMeta> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {}
    }
    const result: Record<string, CompletionRatioMeta> = {}
    for (const [modelName, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        continue
      }
      const candidate = value as Record<string, unknown>
      if (
        modelName.trim() !== '' &&
        typeof candidate.ratio === 'number' &&
        Number.isFinite(candidate.ratio) &&
        candidate.ratio >= 0 &&
        typeof candidate.locked === 'boolean'
      ) {
        result[modelName] = {
          ratio: candidate.ratio,
          locked: candidate.locked,
        }
      }
    }
    return result
  } catch {
    return {}
  }
}

export function parseNumberRecord(
  raw: string | undefined
): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {}
    }
    return parsed as Record<string, number>
  } catch {
    return {}
  }
}
