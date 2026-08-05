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

import { buildModelsDevBillingExpression } from '../../channels/lib/newapi-onboard-pricing'
import type { ModelsDevTokenCost, NewAPIProbeModel } from '../../channels/types'
import type { PriceCompareChannel } from '../types'

const DEFAULT_QUOTA_PER_UNIT = 500_000

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

export type OfficialPriceTierPlan = {
  name: string
  contextThreshold: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  sellInput: number
  sellOutput: number
  sellCacheRead: number
  sellCacheWrite: number
}

export type OfficialSyncPlan = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  sellInput: number
  sellOutput: number
  sellCacheRead: number
  sellCacheWrite: number
  tiers: OfficialPriceTierPlan[]
  billingExpression: string
}

export type OfficialPricingSyncRequest = {
  model_name: string
  billing_mode: 'tiered_expr'
  billing_expr: string
  channel_id: number
  upstream_provider: string
  purchase_price: {
    input: number
    output: number
    cache_read: number
    cache_write: number
    source: 'models_dev'
    provider: string
    tiers: Array<{
      name: string
      context_threshold: number
      input: number
      output: number
      cache_read: number
      cache_write: number
    }>
  }
}

// Current markup of one token class over its effective upstream cost:
// (selling price - effective upstream cost) / effective upstream cost * 100.
// Returns null when the selling price or the effective cost is missing or
// invalid. The cost must be positive: it anchors the markup.
export function currentMarkupPercent(
  sellingPrice: number,
  effectiveCost: number
): number | null {
  if (
    !Number.isFinite(sellingPrice) ||
    sellingPrice < 0 ||
    !Number.isFinite(effectiveCost) ||
    effectiveCost <= 0
  ) {
    return null
  }
  const markup = ((sellingPrice - effectiveCost) / effectiveCost) * 100
  // An extreme selling price can overflow finite numbers; that is numeric
  // unrepresentability, not a valid markup.
  return Number.isFinite(markup) ? markup : null
}

// Gross profit for one token class: selling price minus the effective
// upstream cost. May be negative when the price sits below cost. Returns null
// when either input is not finite.
export function grossProfitUsd(
  sellingPrice: number,
  effectiveCost: number
): number | null {
  if (!Number.isFinite(sellingPrice) || !Number.isFinite(effectiveCost)) {
    return null
  }
  const profit = sellingPrice - effectiveCost
  return Number.isFinite(profit) ? profit : null
}

// True gross margin for one token class:
// (selling price - effective upstream cost) / selling price * 100. Requires a
// positive finite selling price — a zero sale price cannot anchor a margin —
// and a finite cost. Unlike markup, margin divides by the selling price, not
// by the cost.
export function grossMarginPercent(
  sellingPrice: number,
  effectiveCost: number
): number | null {
  if (
    !Number.isFinite(sellingPrice) ||
    sellingPrice <= 0 ||
    !Number.isFinite(effectiveCost)
  ) {
    return null
  }
  const margin = ((sellingPrice - effectiveCost) / sellingPrice) * 100
  return Number.isFinite(margin) ? margin : null
}

export type CurrentMarkupInput = {
  sellingInput: number
  sellingOutput: number
  costInput: number
  costOutput: number
}

// Default target markup is the lower of the current input and output markups,
// rounded to at most two decimals (no trailing zeroes). Both markups must be
// computable and non-negative, otherwise the dialog keeps its existing safe
// fallback. There is no upper bound.
export function defaultTargetMarkupPercent(
  input: CurrentMarkupInput
): number | null {
  const inputMarkup = currentMarkupPercent(input.sellingInput, input.costInput)
  const outputMarkup = currentMarkupPercent(
    input.sellingOutput,
    input.costOutput
  )
  if (inputMarkup === null || outputMarkup === null) return null
  const markup = Math.min(inputMarkup, outputMarkup)
  if (markup < 0) return null
  return Math.round(markup * 100) / 100
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

// New rows carry an explicit channel-level source marker. Rows created before
// that marker existed retain the prior selection rule for compatibility.
export function shouldUseOfficialPricing(
  channel: PriceCompareChannel,
  basis: UpstreamCostBasis | null
): boolean {
  if (channel.uses_official_pricing !== undefined) {
    return channel.uses_official_pricing
  }
  return channel.billing_mode === 'tiered_expr' || basis === null
}

function ceilRatio(value: number): number {
  return Math.ceil(value * 1e6) / 1e6
}

// Selling price = cost * (1 + markup / 100). Every finite non-negative markup
// is accepted; there is no business upper bound. Plans that would overflow
// finite pricing ratios are rejected by the plan builders themselves.
export function parseTargetMarkup(raw: string): number | null {
  if (raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

export function computeSyncRatios(
  cost: UpstreamCostBasis,
  markupPercent: number,
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
  if (!Number.isFinite(markupPercent) || markupPercent < 0) {
    return null
  }
  if (!Number.isFinite(groupRatio) || groupRatio <= 0) {
    return null
  }
  if (!Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) {
    return null
  }
  const markupMultiplier = 1 + markupPercent / 100
  const requestedInput = cost.input * markupMultiplier
  const requestedOutput = cost.output * markupMultiplier
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
  const cacheRatio = ceilRatio((cost.cacheRead * markupMultiplier) / sellInput)
  const createCacheRatio = ceilRatio(
    (cost.cacheWrite * markupMultiplier) / sellInput
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

// Effective Models.dev upstream token costs (base price times the upstream
// multiplier). Shared by official plan construction and the dialog's cost
// display so the displayed cost never depends on the target markup.
export function officialTokenPrices(
  cost: ModelsDevTokenCost,
  multiplier: number
): Pick<OfficialSyncPlan, 'input' | 'output' | 'cacheRead' | 'cacheWrite'> {
  return {
    input: cost.input * multiplier,
    output: cost.output * multiplier,
    cacheRead: (cost.cache_read ?? 0) * multiplier,
    cacheWrite: (cost.cache_write ?? 0) * multiplier,
  }
}

export function computeOfficialSyncPlan(
  model: NewAPIProbeModel,
  markupPercent: number,
  groupRatio: number
): OfficialSyncPlan | null {
  const pricing = model.models_dev_pricing
  if (
    !pricing ||
    !Number.isFinite(markupPercent) ||
    markupPercent < 0 ||
    !Number.isFinite(groupRatio) ||
    groupRatio <= 0 ||
    !Number.isFinite(pricing.upstream_multiplier) ||
    pricing.upstream_multiplier <= 0
  ) {
    return null
  }
  const markupMultiplier = 1 + markupPercent / 100
  const base = officialTokenPrices(pricing.base, pricing.upstream_multiplier)
  if (
    !Number.isFinite(base.input) ||
    !Number.isFinite(base.output) ||
    !Number.isFinite(base.cacheRead) ||
    !Number.isFinite(base.cacheWrite) ||
    base.input <= 0 ||
    base.output < 0 ||
    base.cacheRead < 0 ||
    base.cacheWrite < 0
  ) {
    return null
  }
  const sellInput = base.input * markupMultiplier
  const sellOutput = base.output * markupMultiplier
  const sellCacheRead = base.cacheRead * markupMultiplier
  const sellCacheWrite = base.cacheWrite * markupMultiplier
  // An extreme markup can overflow finite pricing; that is numeric
  // unrepresentability, not a business cap.
  if (
    !Number.isFinite(sellInput) ||
    !Number.isFinite(sellOutput) ||
    !Number.isFinite(sellCacheRead) ||
    !Number.isFinite(sellCacheWrite)
  ) {
    return null
  }
  const billingExpression = buildModelsDevBillingExpression(
    model,
    sellInput,
    sellOutput,
    groupRatio
  )
  if (!billingExpression) return null
  const tiers: OfficialPriceTierPlan[] = []
  for (const tier of pricing.tiers) {
    const cost = officialTokenPrices(tier, pricing.upstream_multiplier)
    const tierSellInput = cost.input * markupMultiplier
    const tierSellOutput = cost.output * markupMultiplier
    const tierSellCacheRead = cost.cacheRead * markupMultiplier
    const tierSellCacheWrite = cost.cacheWrite * markupMultiplier
    if (
      !Number.isFinite(tierSellInput) ||
      !Number.isFinite(tierSellOutput) ||
      !Number.isFinite(tierSellCacheRead) ||
      !Number.isFinite(tierSellCacheWrite)
    ) {
      return null
    }
    tiers.push({
      name: `context_${tier.context_threshold}`,
      contextThreshold: tier.context_threshold,
      ...cost,
      sellInput: tierSellInput,
      sellOutput: tierSellOutput,
      sellCacheRead: tierSellCacheRead,
      sellCacheWrite: tierSellCacheWrite,
    })
  }
  return {
    ...base,
    sellInput,
    sellOutput,
    sellCacheRead,
    sellCacheWrite,
    tiers,
    billingExpression,
  }
}

export function buildOfficialSyncRequest(
  modelName: string,
  channelId: number,
  providerId: string,
  plan: OfficialSyncPlan
): OfficialPricingSyncRequest {
  return {
    model_name: modelName,
    billing_mode: 'tiered_expr',
    billing_expr: plan.billingExpression,
    channel_id: channelId,
    upstream_provider: providerId,
    purchase_price: {
      input: plan.input,
      output: plan.output,
      cache_read: plan.cacheRead,
      cache_write: plan.cacheWrite,
      source: 'models_dev',
      provider: providerId,
      tiers: plan.tiers.map((tier) => ({
        name: tier.name,
        context_threshold: tier.contextThreshold,
        input: tier.input,
        output: tier.output,
        cache_read: tier.cacheRead,
        cache_write: tier.cacheWrite,
      })),
    },
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
