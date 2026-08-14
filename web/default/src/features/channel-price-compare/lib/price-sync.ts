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

import {
  RATIO_TO_USD_PER_MILLION,
  buildModelsDevBillingExpression,
  quantizeModelsDevExpressionCoefficient,
} from '../../channels/lib/newapi-onboard-pricing'
import type {
  ModelsDevCostTier,
  ModelsDevPricing,
  ModelsDevTokenCost,
  NewAPIProbeModel,
} from '../../channels/types'
import type { PriceCompareChannel } from '../types'

const DEFAULT_QUOTA_PER_UNIT = 500_000
const GROK46_UNIFIED_MIN_CONTEXT_THRESHOLD = 200_000

export type UpstreamCostBasis = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  source: 'manual' | 'detected'
}

function isValidUpstreamCostBasis(cost: UpstreamCostBasis): boolean {
  return (
    Number.isFinite(cost.input) &&
    cost.input > 0 &&
    Number.isFinite(cost.output) &&
    cost.output >= 0 &&
    Number.isFinite(cost.cacheRead) &&
    cost.cacheRead >= 0 &&
    Number.isFinite(cost.cacheWrite) &&
    cost.cacheWrite >= 0
  )
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
  billing_mode: 'ratio'
  model_ratio: number
  completion_ratio?: number
  cache_ratio: number
  create_cache_ratio: number
}

export type UnifiedOfficialPricingSyncRequest = PricingSyncRequest & {
  channel_id: number
  purchase_price: {
    input: number
    output: number
    cache_read: number
    cache_write: number
    source: 'manual'
  }
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

type OfficialPriceValues = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  sellInput: number
  sellOutput: number
  sellCacheRead: number
  sellCacheWrite: number
}

export type TieredOfficialSyncPlan = OfficialPriceValues & {
  billingMode: 'tiered_expr'
  tiers: OfficialPriceTierPlan[]
  billingExpression: string
}

export type UnifiedOfficialSyncPlan = OfficialPriceValues &
  SyncRatioPlan & {
    billingMode: 'ratio'
    tiers: []
  }

export type OfficialSyncPlan = TieredOfficialSyncPlan | UnifiedOfficialSyncPlan

export type OfficialSyncPlanResult =
  | { kind: 'ready'; plan: OfficialSyncPlan }
  | { kind: 'invalid-input' }
  | { kind: 'invalid-source' }
  | { kind: 'overflow' }

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

export type OfficialSourcePricingSyncRequest =
  | OfficialPricingSyncRequest
  | UnifiedOfficialPricingSyncRequest

// Current markup of one token class over its effective upstream cost:
// (selling price - effective upstream cost) / effective upstream cost * 100.
// Returns null when the selling price or the effective cost is missing or
// invalid. The cost must be positive: it anchors the markup.
export function currentCostProfitRatePercent(
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

// Compatibility alias for callers that still use the former markup wording.
export const currentMarkupPercent = currentCostProfitRatePercent

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
export function defaultTargetCostProfitRatePercent(
  input: CurrentMarkupInput
): number | null {
  const inputMarkup = currentCostProfitRatePercent(
    input.sellingInput,
    input.costInput
  )
  const outputMarkup = currentCostProfitRatePercent(
    input.sellingOutput,
    input.costOutput
  )
  if (inputMarkup === null || outputMarkup === null) return null
  const markup = Math.min(inputMarkup, outputMarkup)
  if (markup < 0) return null
  return Math.round(markup * 100) / 100
}

// Compatibility alias for callers that still use the former markup wording.
export const defaultTargetMarkupPercent = defaultTargetCostProfitRatePercent

// Purchase-price priority is manual, then a valid detected price. Models.dev is
// resolved separately as the final fallback when neither basis is available.
export function resolveSyncBasis(
  channel: PriceCompareChannel
): UpstreamCostBasis | null {
  if (channel.status !== 'ok') return null
  if (channel.price_source === 'manual') {
    const manual = {
      input: channel.upstream_input,
      output: channel.upstream_output,
      cacheRead: channel.upstream_cache_read,
      cacheWrite: channel.upstream_cache_write,
      source: 'manual',
    } satisfies UpstreamCostBasis
    return isValidUpstreamCostBasis(manual) ? manual : null
  }
  if (channel.detected_available) {
    const detected = {
      input: channel.detected_input,
      output: channel.detected_output,
      cacheRead: channel.detected_cache_read,
      cacheWrite: channel.detected_cache_write,
      source: 'detected',
    } satisfies UpstreamCostBasis
    return isValidUpstreamCostBasis(detected) ? detected : null
  }
  return null
}

// A valid manual or detected basis always wins. Invalid manual pricing remains
// an operator maintenance error; Models.dev may replace only missing/invalid
// detected pricing when the channel carries an explicit official marker.
export function shouldUseOfficialPricing(
  channel: PriceCompareChannel,
  basis: UpstreamCostBasis | null
): boolean {
  if (basis !== null) return false
  if (channel.price_source === 'manual') return false
  return channel.uses_official_pricing === true
}

function ceilRatio(value: number): number {
  return Math.ceil(value * 1e6) / 1e6
}

// Selling price = cost * (1 + markup / 100). Every finite non-negative markup
// is accepted; there is no business upper bound. Plans that would overflow
// finite pricing ratios are rejected by the plan builders themselves.
export function parseTargetCostProfitRate(raw: string): number | null {
  if (raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

// Compatibility alias for callers that still use the former markup wording.
export const parseTargetMarkup = parseTargetCostProfitRate

export function computeSyncRatios(
  cost: UpstreamCostBasis,
  markupPercent: number,
  groupRatio: number,
  lockedCompletionRatio?: number,
  quotaPerUnit = DEFAULT_QUOTA_PER_UNIT
): SyncRatioPlan | null {
  if (!isValidUpstreamCostBasis(cost)) return null
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
    billing_mode: 'ratio',
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

export function isGrok46UnifiedPricingModel(
  model: NewAPIProbeModel,
  requestedModelName = model.model_name
): boolean {
  return requestedModelName === 'grok-4.6' && model.model_name === 'grok-4.6'
}

function isValidOfficialTokenCost(cost: ModelsDevTokenCost): boolean {
  const optionalCosts = [
    cost.cache_read,
    cost.cache_write,
    cost.input_audio,
    cost.output_audio,
  ]
  return (
    Number.isFinite(cost.input) &&
    cost.input > 0 &&
    Number.isFinite(cost.output) &&
    cost.output >= 0 &&
    optionalCosts.every(
      (value) => value === undefined || (Number.isFinite(value) && value >= 0)
    )
  )
}

function isValidOfficialPricing(pricing: ModelsDevPricing): boolean {
  if (
    !Number.isFinite(pricing.upstream_multiplier) ||
    pricing.upstream_multiplier <= 0 ||
    !isValidOfficialTokenCost(pricing.base)
  ) {
    return false
  }
  let previousThreshold = 0
  for (const tier of pricing.tiers) {
    if (
      !Number.isSafeInteger(tier.context_threshold) ||
      tier.context_threshold <= previousThreshold ||
      !isValidOfficialTokenCost(tier)
    ) {
      return false
    }
    previousThreshold = tier.context_threshold
  }
  return true
}

function officialTokenCostForSync(
  model: NewAPIProbeModel,
  pricing: ModelsDevPricing,
  requestedModelName = model.model_name
): ModelsDevTokenCost | null {
  if (!isGrok46UnifiedPricingModel(model, requestedModelName)) {
    return pricing.base
  }
  let highestEligibleTier: ModelsDevCostTier | null = null
  for (const tier of pricing.tiers) {
    if (tier.context_threshold < GROK46_UNIFIED_MIN_CONTEXT_THRESHOLD) continue
    if (
      highestEligibleTier === null ||
      tier.context_threshold > highestEligibleTier.context_threshold
    ) {
      highestEligibleTier = tier
    }
  }
  return highestEligibleTier
}

export function officialSyncCost(
  model: NewAPIProbeModel,
  requestedModelName = model.model_name
): Pick<
  OfficialSyncPlan,
  'input' | 'output' | 'cacheRead' | 'cacheWrite'
> | null {
  const pricing = model.models_dev_pricing
  if (!pricing || !isValidOfficialPricing(pricing)) return null
  const sourceCost = officialTokenCostForSync(
    model,
    pricing,
    requestedModelName
  )
  return sourceCost
    ? officialTokenPrices(sourceCost, pricing.upstream_multiplier)
    : null
}

function isValidOfficialPlanInput(
  markupPercent: number,
  groupRatio: number
): boolean {
  return (
    Number.isFinite(markupPercent) &&
    markupPercent >= 0 &&
    Number.isFinite(groupRatio) &&
    groupRatio > 0
  )
}

function computeOfficialPriceValues(
  cost: ModelsDevTokenCost,
  upstreamMultiplier: number,
  markupMultiplier: number
): OfficialPriceValues | null {
  const effectiveCost = officialTokenPrices(cost, upstreamMultiplier)
  const values = {
    ...effectiveCost,
    sellInput: effectiveCost.input * markupMultiplier,
    sellOutput: effectiveCost.output * markupMultiplier,
    sellCacheRead: effectiveCost.cacheRead * markupMultiplier,
    sellCacheWrite: effectiveCost.cacheWrite * markupMultiplier,
  }
  return Object.values(values).every(Number.isFinite) ? values : null
}

function computeOfficialTierPlan(
  tier: ModelsDevPricing['tiers'][number],
  upstreamMultiplier: number,
  markupMultiplier: number
): OfficialPriceTierPlan | null {
  const values = computeOfficialPriceValues(
    tier,
    upstreamMultiplier,
    markupMultiplier
  )
  if (!values) return null
  return {
    name: `context_${tier.context_threshold}`,
    contextThreshold: tier.context_threshold,
    ...values,
  }
}

function isRepresentableBillingCoefficient(
  value: number | undefined,
  upstreamMultiplier: number,
  scale: number,
  divisor: number
): boolean {
  if (value === undefined) return true
  const coefficient = (value * upstreamMultiplier * scale) / divisor
  const quantized = quantizeModelsDevExpressionCoefficient(coefficient)
  return (
    Number.isFinite(coefficient) &&
    Number.isFinite(quantized) &&
    (value === 0 || quantized > 0)
  )
}

function hasRepresentableOfficialCostCoefficients(
  cost: ModelsDevTokenCost,
  upstreamMultiplier: number,
  inputScale: number,
  outputScale: number,
  divisor: number
): boolean {
  return (
    isRepresentableBillingCoefficient(
      cost.input,
      upstreamMultiplier,
      inputScale,
      divisor
    ) &&
    isRepresentableBillingCoefficient(
      cost.output,
      upstreamMultiplier,
      outputScale,
      divisor
    ) &&
    isRepresentableBillingCoefficient(
      cost.cache_read,
      upstreamMultiplier,
      inputScale,
      divisor
    ) &&
    isRepresentableBillingCoefficient(
      cost.cache_write,
      upstreamMultiplier,
      inputScale,
      divisor
    ) &&
    isRepresentableBillingCoefficient(
      cost.input_audio,
      upstreamMultiplier,
      inputScale,
      divisor
    ) &&
    isRepresentableBillingCoefficient(
      cost.output_audio,
      upstreamMultiplier,
      outputScale,
      divisor
    )
  )
}

function hasRepresentableOfficialBillingCoefficients(
  pricing: ModelsDevPricing,
  base: OfficialPriceValues,
  groupRatio: number
): boolean {
  const inputScale = base.sellInput / base.input
  const outputScale =
    base.output > 0 ? base.sellOutput / base.output : inputScale
  const divisor = groupRatio * RATIO_TO_USD_PER_MILLION
  if (!Number.isFinite(divisor) || divisor <= 0) return false
  for (const cost of [pricing.base, ...pricing.tiers]) {
    if (
      !hasRepresentableOfficialCostCoefficients(
        cost,
        pricing.upstream_multiplier,
        inputScale,
        outputScale,
        divisor
      )
    ) {
      return false
    }
  }
  return true
}

export function computeOfficialSyncPlanResult(
  model: NewAPIProbeModel,
  markupPercent: number,
  groupRatio: number,
  quotaPerUnit = DEFAULT_QUOTA_PER_UNIT,
  requestedModelName = model.model_name
): OfficialSyncPlanResult {
  const pricing = model.models_dev_pricing
  if (!pricing || !isValidOfficialPricing(pricing)) {
    return { kind: 'invalid-source' }
  }
  if (!isValidOfficialPlanInput(markupPercent, groupRatio)) {
    return { kind: 'invalid-input' }
  }
  if (isGrok46UnifiedPricingModel(model, requestedModelName)) {
    const sourceCost = officialTokenCostForSync(
      model,
      pricing,
      requestedModelName
    )
    if (!sourceCost) return { kind: 'invalid-source' }
    const effectiveCost = officialTokenPrices(
      sourceCost,
      pricing.upstream_multiplier
    )
    const ratioPlan = computeSyncRatios(
      { ...effectiveCost, source: 'manual' },
      markupPercent,
      groupRatio,
      undefined,
      quotaPerUnit
    )
    if (!ratioPlan) return { kind: 'overflow' }
    const sellCacheRead = ratioPlan.sellInput * ratioPlan.cacheRatio
    const sellCacheWrite = ratioPlan.sellInput * ratioPlan.createCacheRatio
    if (!Number.isFinite(sellCacheRead) || !Number.isFinite(sellCacheWrite)) {
      return { kind: 'overflow' }
    }
    return {
      kind: 'ready',
      plan: {
        ...effectiveCost,
        ...ratioPlan,
        billingMode: 'ratio',
        sellCacheRead,
        sellCacheWrite,
        tiers: [],
      },
    }
  }
  const markupMultiplier = 1 + markupPercent / 100
  const base = computeOfficialPriceValues(
    pricing.base,
    pricing.upstream_multiplier,
    markupMultiplier
  )
  if (!base) return { kind: 'overflow' }
  if (!hasRepresentableOfficialBillingCoefficients(pricing, base, groupRatio)) {
    return { kind: 'overflow' }
  }
  const tiers: OfficialPriceTierPlan[] = []
  for (const tier of pricing.tiers) {
    const tierPlan = computeOfficialTierPlan(
      tier,
      pricing.upstream_multiplier,
      markupMultiplier
    )
    if (!tierPlan) return { kind: 'overflow' }
    tiers.push(tierPlan)
  }
  const billingExpression = buildModelsDevBillingExpression(
    model,
    base.sellInput,
    base.sellOutput,
    groupRatio
  )
  if (!billingExpression) return { kind: 'invalid-source' }
  return {
    kind: 'ready',
    plan: {
      ...base,
      billingMode: 'tiered_expr',
      tiers,
      billingExpression,
    },
  }
}

export function computeOfficialSyncPlan(
  model: NewAPIProbeModel,
  markupPercent: number,
  groupRatio: number,
  quotaPerUnit = DEFAULT_QUOTA_PER_UNIT,
  requestedModelName = model.model_name
): OfficialSyncPlan | null {
  const result = computeOfficialSyncPlanResult(
    model,
    markupPercent,
    groupRatio,
    quotaPerUnit,
    requestedModelName
  )
  return result.kind === 'ready' ? result.plan : null
}

export function buildOfficialSyncRequest(
  modelName: string,
  channelId: number,
  providerId: string,
  plan: OfficialSyncPlan
): OfficialSourcePricingSyncRequest {
  if (plan.billingMode === 'ratio') {
    return {
      ...buildSyncRequest(modelName, plan),
      channel_id: channelId,
      purchase_price: {
        input: plan.input,
        output: plan.output,
        cache_read: plan.cacheRead,
        cache_write: plan.cacheWrite,
        source: 'manual',
      },
    }
  }
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
