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
import type { NewAPIProbeModel } from '../types'

// ratio 1 == $0.002 / 1K tokens == $2 / 1M tokens (new-api quota anchor)
export const RATIO_TO_USD_PER_MILLION = 2

export type RatioOptionMaps = {
  ModelRatio: Record<string, number>
  CompletionRatio: Record<string, number>
  CacheRatio: Record<string, number>
  CreateCacheRatio: Record<string, number>
  ModelPrice: Record<string, number>
}

export const RATIO_OPTION_KEYS = [
  'ModelRatio',
  'CompletionRatio',
  'CacheRatio',
  'CreateCacheRatio',
  'ModelPrice',
] as const

/** Per-model manual price override, stored in USD ($/1M input, $/1M output). */
export type SaleOverride = { in?: number; out?: number }

export function parseJsonRecord(
  raw: string | undefined
): Record<string, number> {
  try {
    return JSON.parse(raw || '{}') as Record<string, number>
  } catch {
    return {}
  }
}

export function extractRatioMaps(
  options: Array<{ key: string; value: string }>
): RatioOptionMaps {
  const byKey = new Map(options.map((o) => [o.key, o.value]))
  return {
    ModelRatio: parseJsonRecord(byKey.get('ModelRatio')),
    CompletionRatio: parseJsonRecord(byKey.get('CompletionRatio')),
    CacheRatio: parseJsonRecord(byKey.get('CacheRatio')),
    CreateCacheRatio: parseJsonRecord(byKey.get('CreateCacheRatio')),
    ModelPrice: parseJsonRecord(byKey.get('ModelPrice')),
  }
}

export function roundRatio(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** Upstream cost in USD per 1M input tokens (or per call for quota_type 1). */
export function upstreamCostInUSD(
  model: NewAPIProbeModel,
  upstreamGroupRatio: number
): number {
  if (model.quota_type === 1) {
    return model.model_price * upstreamGroupRatio
  }
  return model.model_ratio * upstreamGroupRatio * RATIO_TO_USD_PER_MILLION
}

/** Upstream cost in USD per 1M output tokens; null for per-call models. */
export function upstreamCostOutUSD(
  model: NewAPIProbeModel,
  upstreamGroupRatio: number
): number | null {
  if (model.quota_type === 1) return null
  return upstreamCostInUSD(model, upstreamGroupRatio) * model.completion_ratio
}

/**
 * Write one model's local pricing. saleInUSD / saleOutUSD are the FINAL prices
 * the end user pays ($/1M input, $/1M output; per-call price for quota_type 1).
 * siteGroupRatio is our own group ratio, divided out so that
 * final price == written ratio x anchor x siteGroupRatio.
 */
export function applyModelPricing(
  model: NewAPIProbeModel,
  saleInUSD: number,
  saleOutUSD: number | null,
  siteGroupRatio: number,
  maps: RatioOptionMaps
): RatioOptionMaps {
  const name = model.model_name
  const divisor = siteGroupRatio > 0 ? siteGroupRatio : 1
  const next: RatioOptionMaps = {
    ModelRatio: { ...maps.ModelRatio },
    CompletionRatio: { ...maps.CompletionRatio },
    CacheRatio: { ...maps.CacheRatio },
    CreateCacheRatio: { ...maps.CreateCacheRatio },
    ModelPrice: { ...maps.ModelPrice },
  }
  if (model.quota_type === 1) {
    next.ModelPrice[name] = roundRatio(saleInUSD / divisor)
    delete next.ModelRatio[name]
    delete next.CompletionRatio[name]
    delete next.CacheRatio[name]
    delete next.CreateCacheRatio[name]
    return next
  }
  next.ModelRatio[name] = roundRatio(
    saleInUSD / RATIO_TO_USD_PER_MILLION / divisor
  )
  const completion =
    saleInUSD > 0 && saleOutUSD !== null
      ? saleOutUSD / saleInUSD
      : model.completion_ratio
  if (completion > 0) {
    next.CompletionRatio[name] = roundRatio(completion)
  }
  if (model.cache_ratio > 0) {
    next.CacheRatio[name] = roundRatio(model.cache_ratio)
  }
  if (model.create_cache_ratio > 0) {
    next.CreateCacheRatio[name] = roundRatio(model.create_cache_ratio)
  }
  delete next.ModelPrice[name]
  return next
}
