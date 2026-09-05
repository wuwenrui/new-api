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
import {
  parseCompletionRatioMeta,
  parseNumberRecord,
} from '../../channel-price-compare/lib/price-sync'
import type {
  PricingOptionsUpdateRequest,
  SystemOption,
} from '../../system-settings/types'

export const SALE_FIELDS = [
  'input',
  'output',
  'cache_read',
  'cache_write',
] as const
export type SaleField = (typeof SALE_FIELDS)[number]
export type TokenPrices = Record<SaleField, number>
export type SaleSnapshot = {
  model: string
  key: string
  status: 'missing' | 'ratio' | 'fixed' | 'tiered' | 'incomplete'
  prices: TokenPrices | null // USD per million tokens, group multiplier = 1
  groups: Record<string, number>
  lockedCompletion: number | null
  fixedPrice: number | null
  expression: string
}
export type SaleDraft = {
  base: SaleSnapshot
  group: string
  margin: string
  manual?: Record<SaleField, string>
}

export function parsePriceRecord(
  raw: string | undefined
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw || '{}')
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid pricing data')
  }
  return parsed as Record<string, unknown>
}

export function parsePurchase(value: unknown): TokenPrices | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    !SALE_FIELDS.every(
      (field) =>
        typeof record[field] === 'number' &&
        Number.isFinite(record[field]) &&
        record[field] >= 0
    )
  ) {
    return null
  }
  return Object.fromEntries(
    SALE_FIELDS.map((field) => [field, record[field]])
  ) as TokenPrices
}

export function readSaleSnapshot(
  model: string,
  options: SystemOption[]
): SaleSnapshot {
  const read = (key: string) =>
    options.find((option) => option.key === key)?.value
  const key = read('PricingModelKey') || model
  // Validate the maps instead of turning a malformed/failed response into "unpriced".
  for (const name of [
    'GroupRatio',
    'ModelRatio',
    'CompletionRatio',
    'CacheRatio',
    'CreateCacheRatio',
    'ModelPrice',
    'billing_setting.billing_mode',
    'billing_setting.billing_expr',
  ]) {
    parsePriceRecord(read(name))
  }
  const groups = parseNumberRecord(read('GroupRatio'))
  const meta = parseCompletionRatioMeta(read('CompletionRatioMeta'))
  const completion = meta[model] ?? meta[key]
  const ratio = parseNumberRecord(read('ModelRatio'))[key]
  const fixedPrice = parseNumberRecord(read('ModelPrice'))[key] ?? null
  const mode = parsePriceRecord(read('billing_setting.billing_mode'))[model]
  const expression = String(
    parsePriceRecord(read('billing_setting.billing_expr'))[model] || ''
  )
  const snapshot: SaleSnapshot = {
    model,
    key,
    groups,
    fixedPrice,
    expression,
    lockedCompletion: completion?.locked ? completion.ratio : null,
    prices: null,
    status: 'missing',
  }
  if (mode === 'tiered_expr') {
    return { ...snapshot, status: expression ? 'tiered' : 'incomplete' }
  }
  if (fixedPrice !== null) return { ...snapshot, status: 'fixed' }
  if (ratio === undefined) return snapshot
  const outputRatio =
    completion?.ratio ?? parseNumberRecord(read('CompletionRatio'))[key]
  if (outputRatio === undefined) return { ...snapshot, status: 'incomplete' }
  const input = ratio * 2
  const prices = parsePurchase({
    input,
    output: input * outputRatio,
    cache_read: input * (parseNumberRecord(read('CacheRatio'))[model] ?? 1),
    cache_write:
      input * (parseNumberRecord(read('CreateCacheRatio'))[model] ?? 1.25),
  })
  return { ...snapshot, prices, status: prices ? 'ratio' : 'incomplete' }
}

export function scalePrices(
  prices: TokenPrices,
  multiplier: number
): TokenPrices {
  return Object.fromEntries(
    SALE_FIELDS.map((field) => [field, prices[field] * multiplier])
  ) as TokenPrices
}

export function grossMargin(sale: number, cost: number): number | null {
  if (
    !Number.isFinite(sale) ||
    !Number.isFinite(cost) ||
    sale <= 0 ||
    cost < 0
  ) {
    return null
  }
  return ((sale - cost) / sale) * 100
}

export function saleFromMargin(
  cost: TokenPrices,
  margin: number
): TokenPrices | null {
  if (
    !parsePurchase(cost) ||
    !Number.isFinite(margin) ||
    margin < 0 ||
    margin >= 100
  ) {
    return null
  }
  return parsePurchase(scalePrices(cost, 1 / (1 - margin / 100)))
}

export function draftPrices(
  draft: SaleDraft,
  cost: TokenPrices | null
): TokenPrices | null {
  const manual = draft.manual
  if (manual) {
    if (SALE_FIELDS.some((field) => manual[field].trim() === '')) {
      return null
    }
    return parsePurchase(
      Object.fromEntries(
        SALE_FIELDS.map((field) => [field, Number(manual[field])])
      )
    )
  }
  if (!cost || draft.margin.trim() === '') return null
  return saleFromMargin(cost, Number(draft.margin))
}

export function buildSaleRequest(
  snapshot: SaleSnapshot,
  prices: TokenPrices,
  groupRatio: number
): PricingOptionsUpdateRequest {
  if (snapshot.status === 'fixed' || snapshot.status === 'tiered') {
    throw new Error('Use pricing management for per-request or tiered models.')
  }
  if (
    !parsePurchase(prices) ||
    prices.input <= 0 ||
    !Number.isFinite(groupRatio) ||
    groupRatio <= 0
  ) {
    throw new Error(
      'Enter a positive input price and valid token prices and group multiplier.'
    )
  }
  const completion = prices.output / prices.input
  if (
    snapshot.lockedCompletion !== null &&
    Math.abs(completion - snapshot.lockedCompletion) >
      1e-10 * Math.max(1, completion)
  ) {
    throw new Error(
      'The proposed output price conflicts with the system-locked output ratio.'
    )
  }
  const request: PricingOptionsUpdateRequest = {
    model_name: snapshot.model,
    billing_mode: 'ratio',
    model_ratio: prices.input / (2 * groupRatio),
    cache_ratio: prices.cache_read / prices.input,
    create_cache_ratio: prices.cache_write / prices.input,
  }
  if (snapshot.lockedCompletion === null) request.completion_ratio = completion
  if (
    request.model_ratio <= 0 ||
    Object.values(request).some(
      (value) => typeof value === 'number' && !Number.isFinite(value)
    )
  ) {
    throw new Error(
      'Enter a positive input price and valid token prices and group multiplier.'
    )
  }
  return request
}

export function snapshotSignature(
  snapshot: SaleSnapshot,
  group: string
): string {
  return JSON.stringify({
    ...snapshot,
    groups: { [group]: snapshot.groups[group] },
  })
}
