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
  'billing_setting.billing_mode': Record<string, string>
  'billing_setting.billing_expr': Record<string, string>
}

export const RATIO_OPTION_KEYS = [
  'ModelRatio',
  'CompletionRatio',
  'CacheRatio',
  'CreateCacheRatio',
  'ModelPrice',
  'billing_setting.billing_expr',
  'billing_setting.billing_mode',
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

function parseStringRecord(raw: string | undefined): Record<string, string> {
  try {
    return JSON.parse(raw || '{}') as Record<string, string>
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
    'billing_setting.billing_mode': parseStringRecord(
      byKey.get('billing_setting.billing_mode')
    ),
    'billing_setting.billing_expr': parseStringRecord(
      byKey.get('billing_setting.billing_expr')
    ),
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
  if (model.models_dev_pricing) {
    return model.models_dev_pricing.base.input * upstreamGroupRatio
  }
  return model.model_ratio * upstreamGroupRatio * RATIO_TO_USD_PER_MILLION
}

/** Upstream cost in USD per 1M output tokens; null for per-call models. */
export function upstreamCostOutUSD(
  model: NewAPIProbeModel,
  upstreamGroupRatio: number
): number | null {
  if (model.quota_type === 1) return null
  if (model.models_dev_pricing) {
    return model.models_dev_pricing.base.output * upstreamGroupRatio
  }
  return upstreamCostInUSD(model, upstreamGroupRatio) * model.completion_ratio
}

function formatExprNumber(value: number): string {
  return String(Math.round(value * 1e9) / 1e9)
}

function modelsDevCostExpression(
  cost: NonNullable<NewAPIProbeModel['models_dev_pricing']>['base'],
  upstreamMultiplier: number,
  inputScale: number,
  outputScale: number,
  siteGroupRatio: number
): string {
  const divisor = siteGroupRatio > 0 ? siteGroupRatio : 1
  const inputCoefficient =
    (cost.input * upstreamMultiplier * inputScale) / divisor
  const outputCoefficient =
    (cost.output * upstreamMultiplier * outputScale) / divisor
  const terms = [
    `p * ${formatExprNumber(inputCoefficient)}`,
    `c * ${formatExprNumber(outputCoefficient)}`,
  ]
  if (cost.cache_read !== undefined) {
    terms.push(
      `cr * ${formatExprNumber(
        (cost.cache_read * upstreamMultiplier * inputScale) / divisor
      )}`
    )
  }
  if (cost.cache_write !== undefined) {
    const cacheWriteCoefficient =
      (cost.cache_write * upstreamMultiplier * inputScale) / divisor
    terms.push(`cc * ${formatExprNumber(cacheWriteCoefficient)}`)
    terms.push(`cc1h * ${formatExprNumber(cacheWriteCoefficient)}`)
  }
  if (cost.input_audio !== undefined) {
    terms.push(
      `ai * ${formatExprNumber(
        (cost.input_audio * upstreamMultiplier * inputScale) / divisor
      )}`
    )
  }
  if (cost.output_audio !== undefined) {
    terms.push(
      `ao * ${formatExprNumber(
        (cost.output_audio * upstreamMultiplier * outputScale) / divisor
      )}`
    )
  }
  return terms.join(' + ')
}

export function buildModelsDevBillingExpression(
  model: NewAPIProbeModel,
  saleInUSD: number,
  saleOutUSD: number,
  siteGroupRatio: number
): string | null {
  const pricing = model.models_dev_pricing
  if (!pricing) return null

  const baseInputCost = pricing.base.input * pricing.upstream_multiplier
  const baseOutputCost = pricing.base.output * pricing.upstream_multiplier
  const inputScale = baseInputCost > 0 ? saleInUSD / baseInputCost : 1
  const outputScale = baseOutputCost > 0 ? saleOutUSD / baseOutputCost : 1
  const tierExpr = (
    name: string,
    cost: NonNullable<NewAPIProbeModel['models_dev_pricing']>['base']
  ) =>
    `tier("${name}", ${modelsDevCostExpression(
      cost,
      pricing.upstream_multiplier,
      inputScale,
      outputScale,
      siteGroupRatio
    )})`

  let expression = tierExpr(
    pricing.tiers.length === 0
      ? 'base'
      : `context_${pricing.tiers.at(-1)?.context_threshold}`,
    pricing.tiers.at(-1) ?? pricing.base
  )
  for (let index = pricing.tiers.length - 1; index >= 0; index -= 1) {
    const threshold = pricing.tiers[index].context_threshold
    const lowerCost = index === 0 ? pricing.base : pricing.tiers[index - 1]
    const lowerName =
      index === 0
        ? 'base'
        : `context_${pricing.tiers[index - 1].context_threshold}`
    expression = `len < ${threshold} ? ${tierExpr(lowerName, lowerCost)} : ${expression}`
  }
  return expression
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
    'billing_setting.billing_mode': {
      ...maps['billing_setting.billing_mode'],
    },
    'billing_setting.billing_expr': {
      ...maps['billing_setting.billing_expr'],
    },
  }
  if (model.quota_type === 1) {
    next.ModelPrice[name] = roundRatio(saleInUSD / divisor)
    delete next.ModelRatio[name]
    delete next.CompletionRatio[name]
    delete next.CacheRatio[name]
    delete next.CreateCacheRatio[name]
    delete next['billing_setting.billing_mode'][name]
    delete next['billing_setting.billing_expr'][name]
    return next
  }
  const modelsDevExpression =
    saleOutUSD === null
      ? null
      : buildModelsDevBillingExpression(
          model,
          saleInUSD,
          saleOutUSD,
          siteGroupRatio
        )
  if (modelsDevExpression) {
    next['billing_setting.billing_mode'][name] = 'tiered_expr'
    next['billing_setting.billing_expr'][name] = modelsDevExpression
    delete next.ModelRatio[name]
    delete next.CompletionRatio[name]
    delete next.CacheRatio[name]
    delete next.CreateCacheRatio[name]
    delete next.ModelPrice[name]
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
  delete next['billing_setting.billing_mode'][name]
  delete next['billing_setting.billing_expr'][name]
  return next
}
