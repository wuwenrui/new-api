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
import { assert, describe, expect, test } from 'vitest'

import type { NewAPIProbeModel } from '../../channels/types'
import type { PriceCompareChannel } from '../types'
import {
  buildOfficialSyncRequest,
  buildSyncRequest,
  computeOfficialSyncPlan,
  computeOfficialSyncPlanResult,
  computeSyncRatios,
  currentCostProfitRatePercent,
  currentMarkupPercent,
  defaultTargetMarkupPercent,
  grossMarginPercent,
  grossProfitUsd,
  shouldUseOfficialPricing,
  parseCompletionRatioMeta,
  parseTargetCostProfitRate,
  parseTargetMarkup,
  parseNumberRecord,
  resolveSyncBasis,
  type UpstreamCostBasis,
} from './price-sync'

const basis = (overrides: Partial<UpstreamCostBasis>): UpstreamCostBasis => ({
  input: 2,
  output: 8,
  cacheRead: 0.2,
  cacheWrite: 2,
  source: 'detected',
  ...overrides,
})

const officialModel = {
  model_name: 'gpt-5.6-sol',
  vendor_id: 1,
  quota_type: 0,
  model_ratio: 2.5,
  model_price: 0,
  completion_ratio: 6,
  cache_ratio: 0.1,
  create_cache_ratio: 1.25,
  image_ratio: 0,
  audio_ratio: 0,
  audio_completion_ratio: 0,
  enable_groups: ['openai'],
  supported_endpoint_types: ['openai'],
  models_dev_pricing: {
    base: {
      input: 5,
      output: 30,
      cache_read: 0.5,
      cache_write: 6.25,
    },
    tiers: [
      {
        context_threshold: 272_000,
        input: 10,
        output: 45,
        cache_read: 1,
        cache_write: 12.5,
      },
    ],
    upstream_multiplier: 1,
  },
} satisfies NewAPIProbeModel

const grok46OfficialModel = {
  ...officialModel,
  model_name: 'grok-4.6',
  enable_groups: ['xai'],
  models_dev_pricing: {
    base: {
      input: 2,
      output: 10,
      cache_read: 0.2,
      cache_write: 2.5,
    },
    tiers: [
      {
        context_threshold: 200_000,
        input: 4,
        output: 20,
        cache_read: 0.4,
        cache_write: 5,
      },
      {
        context_threshold: 1_000_000,
        input: 6,
        output: 30,
        cache_read: 0.6,
        cache_write: 7.5,
      },
    ],
    upstream_multiplier: 0.25,
  },
} satisfies NewAPIProbeModel

const channel = (
  overrides: Partial<PriceCompareChannel>
): PriceCompareChannel => ({
  channel_id: 1,
  channel_name: 'c',
  upstream_group: 'default',
  upstream_model: 'm',
  upstream_price_multiplier: 1,
  uses_official_pricing: false,
  priority: 0,
  weight: 1,
  routing_role: 'primary',
  status: 'ok',
  status_reason: '',
  price_source: 'detected',
  price_changed: false,
  detected_available: true,
  uses_fixed_price: false,
  fixed_price: 0,
  billing_mode: 'ratio',
  local_input: 0,
  local_output: 0,
  local_cache_read: 0,
  local_cache_write: 0,
  upstream_input: 3,
  upstream_output: 9,
  upstream_cache_read: 0.3,
  upstream_cache_write: 3,
  detected_input: 2,
  detected_output: 8,
  detected_cache_read: 0.2,
  detected_cache_write: 2,
  margin_input: 0,
  margin_output: 0,
  today: {
    requests: 0,
    revenue: 0,
    upstream_cost: 0,
    profit: 0,
    margin: 0,
    cost_available: false,
  },
  total: {
    requests: 0,
    revenue: 0,
    upstream_cost: 0,
    profit: 0,
    margin: 0,
    cost_available: false,
  },
  quality_24h: {
    successes: 0,
    errors: 0,
    success_rate: 0,
    average_use_time: 0,
    last_error_at: 0,
    last_error_code: '',
  },
  recommendations: [],
  ...overrides,
})

describe('resolveSyncBasis', () => {
  test('prefers detected prices when the purchase price is not manual', () => {
    const result = resolveSyncBasis(channel({}))
    expect(result?.source).toBe('detected')
    expect(result?.input).toBe(2)
    expect(result?.output).toBe(8)
  })

  test('prefers a manual purchase price even when detection is available', () => {
    const result = resolveSyncBasis(
      channel({ price_source: 'manual', detected_available: true })
    )
    expect(result?.source).toBe('manual')
    expect(result?.input).toBe(3)
    expect(result?.output).toBe(9)
  })

  test('falls back to manual purchase price without detection', () => {
    const result = resolveSyncBasis(
      channel({ detected_available: false, price_source: 'manual' })
    )
    expect(result?.source).toBe('manual')
    expect(result?.input).toBe(3)
  })

  test('returns null when neither manual nor detected pricing is available', () => {
    expect(
      resolveSyncBasis(
        channel({ price_source: 'missing', detected_available: false })
      )
    ).toBeNull()
  })

  test('returns null when price is not maintained', () => {
    expect(resolveSyncBasis(channel({ status: 'unknown' }))).toBeNull()
  })
})

describe('shouldUseOfficialPricing', () => {
  test('keeps a manual purchase price ahead of the official source marker', () => {
    const manualBasis = resolveSyncBasis(
      channel({ price_source: 'manual', uses_official_pricing: true })
    )
    expect(manualBasis?.source).toBe('manual')
    expect(
      shouldUseOfficialPricing(
        channel({ price_source: 'manual', uses_official_pricing: true }),
        manualBasis
      )
    ).toBe(false)
  })

  test('honors explicit source markers before legacy fallbacks', () => {
    const detectedBasis = resolveSyncBasis(channel({}))
    expect(
      shouldUseOfficialPricing(
        channel({ uses_official_pricing: false, billing_mode: 'tiered_expr' }),
        detectedBasis
      )
    ).toBe(false)
    expect(
      shouldUseOfficialPricing(
        channel({
          uses_official_pricing: false,
          status: 'unknown',
          detected_available: false,
        }),
        null
      )
    ).toBe(false)
    expect(
      shouldUseOfficialPricing(
        channel({ uses_official_pricing: true }),
        detectedBasis
      )
    ).toBe(false)
  })

  test('uses official pricing when no manual or detected basis is available', () => {
    const missingChannel = channel({
      price_source: 'missing',
      detected_available: false,
      uses_official_pricing: true,
    })
    const missingBasis = resolveSyncBasis(missingChannel)
    expect(missingBasis).toBeNull()
    expect(shouldUseOfficialPricing(missingChannel, missingBasis)).toBe(true)
  })

  test('requires an explicit official marker for a ratio channel without a basis', () => {
    const missingChannel = channel({
      price_source: 'missing',
      detected_available: false,
      uses_official_pricing: undefined,
      billing_mode: 'ratio',
    })
    const missingBasis = resolveSyncBasis(missingChannel)
    expect(missingBasis).toBeNull()
    expect(shouldUseOfficialPricing(missingChannel, missingBasis)).toBe(false)
  })

  test('does not infer official pricing from a legacy tiered billing mode', () => {
    expect(
      shouldUseOfficialPricing(
        channel({
          uses_official_pricing: undefined,
          billing_mode: 'tiered_expr',
        }),
        resolveSyncBasis(channel({}))
      )
    ).toBe(false)
    expect(
      shouldUseOfficialPricing(
        channel({
          uses_official_pricing: undefined,
          status: 'unknown',
          detected_available: false,
        }),
        null
      )
    ).toBe(false)
  })

  test('routes a persisted Models.dev source through the explicit official marker', () => {
    const persistedOfficialChannel = channel({
      price_source: 'models_dev',
      detected_available: false,
      uses_official_pricing: true,
      billing_mode: 'tiered_expr',
    })

    const persistedBasis = resolveSyncBasis(persistedOfficialChannel)
    expect(persistedBasis).toBeNull()
    expect(
      shouldUseOfficialPricing(persistedOfficialChannel, persistedBasis)
    ).toBe(true)
  })
})

describe('computeSyncRatios', () => {
  test('derives ratios from cost, markup and group ratio', () => {
    // cost in 2 / out 8, markup 100% -> sell 4 / 16; group 1 -> modelRatio 2
    const plan = computeSyncRatios(basis({}), 100, 1)
    assert.ok(plan)
    expect(plan.modelRatio).toBe(2)
    expect(plan.completionRatio).toBe(4)
    expect(plan.cacheRatio).toBe(0.1)
    expect(plan.createCacheRatio).toBe(1)
    expect(plan.sellInput).toBe(4)
    expect(plan.sellOutput).toBe(16)
  })

  test('divides the group ratio out of the model ratio', () => {
    const plan = computeSyncRatios(basis({}), 100, 2)
    assert.ok(plan)
    expect(plan.modelRatio).toBe(1)
    // relative ratios do not depend on markup or group ratio
    expect(plan.completionRatio).toBe(4)
  })

  test('uses the configured quota scale when deriving the model ratio', () => {
    const plan = computeSyncRatios(basis({}), 100, 1, undefined, 1_000_000)
    assert.ok(plan)
    expect(plan.modelRatio).toBe(4)
    expect(plan.sellInput).toBe(4)
  })

  test('zero markup prices at cost', () => {
    const plan = computeSyncRatios(basis({}), 0, 1)
    assert.ok(plan)
    expect(plan.modelRatio).toBe(1)
    expect(plan.sellInput).toBe(2)
  })

  test('marks up 0, 100 and 200 to cost, double and triple', () => {
    const atCost = computeSyncRatios(basis({}), 0, 1)
    assert.ok(atCost)
    expect(atCost.sellInput).toBe(2)
    const doubled = computeSyncRatios(basis({}), 100, 1)
    assert.ok(doubled)
    expect(doubled.sellInput).toBe(4)
    const tripled = computeSyncRatios(basis({}), 200, 1)
    assert.ok(tripled)
    expect(tripled.sellInput).toBe(6)
    const decimal = computeSyncRatios(basis({}), 99.99, 1)
    assert.ok(decimal)
    expect(Number.isFinite(decimal.sellInput)).toBe(true)
    expect(Number.isFinite(decimal.sellOutput)).toBe(true)
    expect(decimal.sellInput > atCost.sellInput).toBe(true)
  })

  test('treats an empty target markup as invalid instead of zero', () => {
    expect(parseTargetMarkup('')).toBeNull()
    expect(parseTargetMarkup('   ')).toBeNull()
    expect(parseTargetMarkup('0')).toBe(0)
  })

  test('accepts any finite non-negative markup and rejects negatives and NaN', () => {
    expect(parseTargetMarkup('99')).toBe(99)
    expect(parseTargetMarkup('99.99')).toBe(99.99)
    expect(parseTargetMarkup('100')).toBe(100)
    expect(parseTargetMarkup('200')).toBe(200)
    expect(parseTargetMarkup('-1')).toBeNull()
    expect(parseTargetMarkup('abc')).toBeNull()
  })

  test('writes zero ratios when the upstream does not charge', () => {
    const plan = computeSyncRatios(
      basis({ output: 0, cacheRead: 0, cacheWrite: 0 }),
      100,
      1
    )
    assert.ok(plan)
    expect(plan.completionRatio).toBe(0)
    expect(plan.cacheRatio).toBe(0)
    expect(plan.createCacheRatio).toBe(0)
  })

  test('rejects invalid markup and non-positive cost', () => {
    expect(computeSyncRatios(basis({}), -1, 1)).toBeNull()
    expect(computeSyncRatios(basis({}), Number.NaN, 1)).toBeNull()
    expect(computeSyncRatios(basis({ input: 0 }), 100, 1)).toBeNull()
  })

  test('rejects a non-positive or invalid group ratio', () => {
    expect(computeSyncRatios(basis({}), 100, 0)).toBeNull()
    expect(computeSyncRatios(basis({}), 100, -1)).toBeNull()
    expect(computeSyncRatios(basis({}), 100, Number.NaN)).toBeNull()
  })

  test('rejects a non-positive or invalid quota scale', () => {
    expect(computeSyncRatios(basis({}), 100, 1, undefined, 0)).toBeNull()
    expect(computeSyncRatios(basis({}), 100, 1, undefined, -1)).toBeNull()
    expect(
      computeSyncRatios(basis({}), 100, 1, undefined, Number.NaN)
    ).toBeNull()
  })

  test('rejects calculations that overflow finite pricing ratios', () => {
    expect(
      computeSyncRatios(basis({ input: Number.MAX_VALUE }), 100, 1e-300)
    ).toBeNull()
  })

  test('honors a locked completion ratio without dropping below target markup', () => {
    const plan = computeSyncRatios(basis({ output: 12 }), 100, 1, 4)
    assert.ok(plan)
    expect(plan.completionRatioLocked).toBe(true)
    expect(plan.modelRatio).toBe(3)
    expect(plan.completionRatio).toBe(4)
    expect(plan.sellInput).toBe(6)
    expect(plan.sellOutput).toBe(24)
    expect(plan.cacheRatio).toBe(0.066667)
    expect(plan.createCacheRatio).toBe(0.666667)
  })
})

describe('computeOfficialSyncPlan', () => {
  test('collapses exact grok-4.6 to the highest context tier and a unified ratio request', () => {
    const result = computeOfficialSyncPlanResult(
      grok46OfficialModel,
      5_000,
      1,
      500_000
    )

    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    expect(result.plan.billingMode).toBe('ratio')
    expect(result.plan.input).toBe(1.5)
    expect(result.plan.output).toBe(7.5)
    expect(result.plan.cacheRead).toBe(0.15)
    expect(result.plan.cacheWrite).toBe(1.875)
    expect(result.plan.sellInput).toBe(76.5)
    expect(result.plan.sellOutput).toBe(382.5)
    expect(result.plan.tiers).toEqual([])
    expect('billingExpression' in result.plan).toBe(false)

    const request = buildOfficialSyncRequest('grok-4.6', 31, 'xai', result.plan)
    expect(request).toEqual({
      model_name: 'grok-4.6',
      billing_mode: 'ratio',
      model_ratio: 38.25,
      completion_ratio: 5,
      cache_ratio: 0.1,
      create_cache_ratio: 1.25,
      channel_id: 31,
      purchase_price: {
        input: 1.5,
        output: 7.5,
        cache_read: 0.15,
        cache_write: 1.875,
        source: 'manual',
      },
    })
  })

  test('keeps similarly named and other official models on tiered pricing', () => {
    const similar = computeOfficialSyncPlan(
      { ...grok46OfficialModel, model_name: 'grok-4.6-preview' },
      30,
      1
    )
    const other = computeOfficialSyncPlan(officialModel, 30, 1)

    assert.ok(similar)
    expect(similar.billingMode).toBe('tiered_expr')
    if (similar.billingMode === 'tiered_expr') {
      expect(similar.tiers.length).toBe(2)
      expect(similar.billingExpression).toMatch(/len < 200000/)
    }
    assert.ok(other)
    expect(other.billingMode).toBe('tiered_expr')
    if (other.billingMode === 'tiered_expr') {
      expect(other.tiers.length).toBe(1)
    }
  })

  test('rejects grok-4.6 when Models.dev has no context tier to collapse', () => {
    const result = computeOfficialSyncPlanResult(
      {
        ...grok46OfficialModel,
        models_dev_pricing: {
          ...grok46OfficialModel.models_dev_pricing,
          tiers: [],
        },
      },
      5_000,
      1,
      500_000
    )

    expect(result.kind).toBe('invalid-source')
  })

  test('rejects grok-4.6 when every Models.dev tier is below 200K context', () => {
    const result = computeOfficialSyncPlanResult(
      {
        ...grok46OfficialModel,
        models_dev_pricing: {
          ...grok46OfficialModel.models_dev_pricing,
          tiers: [
            {
              context_threshold: 128_000,
              input: 5,
              output: 25,
              cache_read: 0.5,
              cache_write: 6.25,
            },
          ],
        },
      },
      5_000,
      1,
      500_000
    )

    expect(result.kind).toBe('invalid-source')
  })

  test('classifies invalid official costs separately from arithmetic overflow', () => {
    const pricing = officialModel.models_dev_pricing
    const zeroInput = computeOfficialSyncPlanResult(
      {
        ...officialModel,
        models_dev_pricing: {
          ...pricing,
          base: { ...pricing.base, input: 0 },
        },
      },
      30,
      1
    )
    expect(zeroInput.kind).toBe('invalid-source')

    const invalidTier = computeOfficialSyncPlanResult(
      {
        ...officialModel,
        models_dev_pricing: {
          ...pricing,
          tiers: [{ ...pricing.tiers[0], input: Number.NaN }],
        },
      },
      30,
      1
    )
    expect(invalidTier.kind).toBe('invalid-source')

    const overflow = computeOfficialSyncPlanResult(
      {
        ...officialModel,
        models_dev_pricing: {
          ...pricing,
          base: { ...pricing.base, input: Number.MAX_VALUE },
          upstream_multiplier: 0.25,
        },
      },
      400,
      1
    )
    expect(overflow.kind).toBe('overflow')
  })

  test('classifies a non-finite billing coefficient from a tiny group ratio as overflow', () => {
    const result = computeOfficialSyncPlanResult(
      officialModel,
      30,
      Number.MIN_VALUE
    )

    expect(result.kind).toBe('overflow')
  })

  test('classifies a non-finite official audio coefficient as overflow', () => {
    const pricing = officialModel.models_dev_pricing
    const result = computeOfficialSyncPlanResult(
      {
        ...officialModel,
        models_dev_pricing: {
          ...pricing,
          base: { ...pricing.base, input_audio: Number.MAX_VALUE },
          upstream_multiplier: 2,
        },
      },
      30,
      1
    )

    expect(result.kind).toBe('overflow')
  })

  test('prices every context tier at a 30 percent markup', () => {
    const plan = computeOfficialSyncPlan(officialModel, 30, 1)
    assert.ok(plan)
    expect(plan.billingMode).toBe('tiered_expr')
    expect(plan.sellInput).toBe(5 * 1.3)
    expect(plan.sellOutput).toBe(30 * 1.3)
    expect(plan.sellCacheRead).toBe(0.5 * 1.3)
    expect(plan.sellCacheWrite).toBe(6.25 * 1.3)
    expect(plan.tiers[0].name).toBe('context_272000')
    expect(plan.tiers[0].sellInput).toBe(10 * 1.3)
    expect(plan.tiers[0].sellOutput).toBe(45 * 1.3)
    if (plan.billingMode === 'tiered_expr') {
      expect(plan.billingExpression).toMatch(/len < 272000/)
      expect(plan.billingExpression.includes('p * 3.25')).toBe(true)
      expect(plan.billingExpression.includes('tier("context_272000"')).toBe(
        true
      )
    }
  })

  test('marks up 0, 100 and 200 to cost, double and triple official prices', () => {
    const atCost = computeOfficialSyncPlan(officialModel, 0, 1)
    assert.ok(atCost)
    expect(atCost.sellInput).toBe(5)
    expect(atCost.sellOutput).toBe(30)
    const doubled = computeOfficialSyncPlan(officialModel, 100, 1)
    assert.ok(doubled)
    expect(doubled.sellInput).toBe(10)
    expect(doubled.sellOutput).toBe(60)
    const tripled = computeOfficialSyncPlan(officialModel, 200, 1)
    assert.ok(tripled)
    expect(tripled.sellInput).toBe(15)
    expect(tripled.sellOutput).toBe(90)
    const decimal = computeOfficialSyncPlan(officialModel, 99.99, 1)
    assert.ok(decimal)
    expect(Number.isFinite(decimal.sellInput)).toBe(true)
    expect(Number.isFinite(decimal.sellOutput)).toBe(true)
  })

  test('builds an atomic official-price update request', () => {
    const plan = computeOfficialSyncPlan(officialModel, 30, 1)
    assert.ok(plan)

    const request = buildOfficialSyncRequest('gpt-5.6-sol', 31, 'openai', plan)

    expect(request.billing_mode).toBe('tiered_expr')
    expect(request.channel_id).toBe(31)
    if (request.billing_mode === 'tiered_expr') {
      expect(request.upstream_provider).toBe('openai')
      expect(request.purchase_price.source).toBe('models_dev')
      expect(request.purchase_price.input).toBe(5)
      expect(request.purchase_price.tiers).toEqual([
        {
          name: 'context_272000',
          context_threshold: 272_000,
          input: 10,
          output: 45,
          cache_read: 1,
          cache_write: 12.5,
        },
      ])
    }
  })

  test('rejects invalid markup, group ratio, and missing official pricing', () => {
    expect(computeOfficialSyncPlan(officialModel, -1, 1)).toBeNull()
    expect(computeOfficialSyncPlan(officialModel, Number.NaN, 1)).toBeNull()
    expect(computeOfficialSyncPlan(officialModel, 30, 0)).toBeNull()
    expect(
      computeOfficialSyncPlan(
        { ...officialModel, models_dev_pricing: undefined },
        30,
        1
      )
    ).toBeNull()
  })

  test('rejects official plans when cache or tier selling prices overflow', () => {
    const pricing = officialModel.models_dev_pricing
    assert.ok(pricing)

    const overflowCache = computeOfficialSyncPlan(
      {
        ...officialModel,
        models_dev_pricing: {
          ...pricing,
          base: { ...pricing.base, cache_read: Number.MAX_VALUE },
        },
      },
      30,
      1
    )
    expect(overflowCache).toBeNull()

    const overflowTier = computeOfficialSyncPlan(
      {
        ...officialModel,
        models_dev_pricing: {
          ...pricing,
          tiers: [{ ...pricing.tiers[0], input: Number.MAX_VALUE }],
        },
      },
      30,
      1
    )
    expect(overflowTier).toBeNull()
  })
})

describe('buildSyncRequest', () => {
  test('builds a model-level pricing update', () => {
    const plan = computeSyncRatios(basis({}), 100, 1)
    assert.ok(plan)
    expect(buildSyncRequest('m', plan)).toEqual({
      model_name: 'm',
      billing_mode: 'ratio',
      model_ratio: 2,
      completion_ratio: 4,
      cache_ratio: 0.1,
      create_cache_ratio: 1,
    })
  })

  test('omits an ignored completion ratio when it is locked', () => {
    const plan = computeSyncRatios(basis({ output: 12 }), 100, 1, 4)
    assert.ok(plan)
    expect(buildSyncRequest('m', plan)).toEqual({
      model_name: 'm',
      billing_mode: 'ratio',
      model_ratio: 3,
      cache_ratio: 0.066667,
      create_cache_ratio: 0.666667,
    })
  })
})

describe('parseCompletionRatioMeta', () => {
  test('keeps only valid completion ratio constraints', () => {
    expect(
      parseCompletionRatioMeta(
        '{"m":{"ratio":4,"locked":true},"bad":{"ratio":"x","locked":true}}'
      )
    ).toEqual({ m: { ratio: 4, locked: true } })
    expect(parseCompletionRatioMeta(undefined)).toEqual({})
    expect(parseCompletionRatioMeta('[1,2]')).toEqual({})
  })
})

describe('parseNumberRecord', () => {
  test('parses JSON maps and tolerates invalid input', () => {
    expect(parseNumberRecord('{"a":1}')).toEqual({ a: 1 })
    expect(parseNumberRecord(undefined)).toEqual({})
    expect(parseNumberRecord('not json')).toEqual({})
    expect(parseNumberRecord('[1,2]')).toEqual({})
  })
})

describe('cost-profit-rate helpers', () => {
  test('calculates 0, 100, and 455.56 percent', () => {
    expect(currentCostProfitRatePercent(1, 1)).toBe(0)
    expect(currentCostProfitRatePercent(2, 1)).toBe(100)
    expect(currentCostProfitRatePercent(5.5556, 1)).toBe(455.56)
  })

  test('parses the cost-profit rate and rejects negatives', () => {
    expect(parseTargetCostProfitRate('455.56')).toBe(455.56)
    expect(parseTargetCostProfitRate('-0.01')).toBeNull()
  })

  test('official 5/30 at multiplier 0.25 against 9/50 selling defaults to 566.67', () => {
    expect(
      defaultTargetMarkupPercent({
        sellingInput: 9,
        sellingOutput: 50,
        costInput: 5 * 0.25,
        costOutput: 30 * 0.25,
      })
    ).toBe(566.67)
  })

  test('detected 2/8 against 6/20 selling defaults to 150', () => {
    expect(
      defaultTargetMarkupPercent({
        sellingInput: 6,
        sellingOutput: 20,
        costInput: 2,
        costOutput: 8,
      })
    ).toBe(150)
  })

  test('rounds the lower markup to at most two decimals', () => {
    // input markup 566.66... is the lower one and rounds to 566.67
    expect(
      defaultTargetMarkupPercent({
        sellingInput: 20,
        sellingOutput: 100,
        costInput: 3,
        costOutput: 5,
      })
    ).toBe(566.67)
  })

  test('uses a current markup of 99 as the dialog default', () => {
    expect(currentMarkupPercent(199, 100)).toBe(99)
    expect(
      defaultTargetMarkupPercent({
        sellingInput: 199,
        sellingOutput: 199,
        costInput: 100,
        costOutput: 100,
      })
    ).toBe(99)
  })

  test('keeps markups of 100 and above as dialog defaults', () => {
    expect(
      defaultTargetMarkupPercent({
        sellingInput: 200,
        sellingOutput: 200,
        costInput: 100,
        costOutput: 100,
      })
    ).toBe(100)
    expect(
      defaultTargetMarkupPercent({
        sellingInput: 300,
        sellingOutput: 300,
        costInput: 100,
        costOutput: 100,
      })
    ).toBe(200)
  })

  test('returns null when the current markup is negative', () => {
    expect(currentMarkupPercent(1, 2)).toBe(-50)
    // the lower class controls: a negative input markup must not be discarded
    expect(
      defaultTargetMarkupPercent({
        sellingInput: 1,
        sellingOutput: 10,
        costInput: 2,
        costOutput: 4,
      })
    ).toBeNull()
  })

  test('returns null when the markup overflows finite numbers', () => {
    expect(currentMarkupPercent(Number.MAX_VALUE, 1)).toBeNull()
  })

  test('returns null when the markup cannot be computed', () => {
    expect(currentMarkupPercent(Number.NaN, 2)).toBeNull()
    expect(currentMarkupPercent(2, 0)).toBeNull()
    expect(currentMarkupPercent(2, -1)).toBeNull()
    expect(currentMarkupPercent(-1, 2)).toBeNull()
    // both input and output are required to establish the lower markup
    expect(
      defaultTargetMarkupPercent({
        sellingInput: 0,
        sellingOutput: 20,
        costInput: 2,
        costOutput: 8,
      })
    ).toBeNull()

    // a non-positive output cost cannot anchor a markup
    expect(
      defaultTargetMarkupPercent({
        sellingInput: 20,
        sellingOutput: 20,
        costInput: 8,
        costOutput: 0,
      })
    ).toBeNull()
  })
})

describe('grossProfitUsd / grossMarginPercent', () => {
  test('screenshot example: cost 1.25/7.50, sale 8.333375/50.00025 -> profit 7.083375/42.50025, margin 85.0%', () => {
    expect(grossProfitUsd(8.333375, 1.25)).toBe(7.083375)
    expect(grossProfitUsd(50.00025, 7.5)).toBe(42.50025)
    expect(grossMarginPercent(8.333375, 1.25)).toBe(85.000074999625)
    expect(grossMarginPercent(50.00025, 7.5)).toBe(85.000074999625)
  })

  test('keeps negative profit and negative margin when price is below cost', () => {
    expect(grossProfitUsd(1, 2)).toBe(-1)
    expect(grossProfitUsd(0, 2)).toBe(-2)
    expect(grossMarginPercent(1, 2)).toBe(-100)
  })

  test('has no margin on a zero or negative selling price', () => {
    expect(grossMarginPercent(0, 2)).toBeNull()
    expect(grossMarginPercent(-1, 2)).toBeNull()
    // a zero sale price still yields a finite loss as gross profit
    expect(grossProfitUsd(0, 2)).toBe(-2)
  })

  test('returns null for non-finite inputs', () => {
    expect(grossProfitUsd(Number.NaN, 1)).toBeNull()
    expect(grossProfitUsd(1, Number.NaN)).toBeNull()
    expect(grossProfitUsd(Number.POSITIVE_INFINITY, 1)).toBeNull()
    expect(grossMarginPercent(Number.NaN, 1)).toBeNull()
    expect(grossMarginPercent(1, Number.NaN)).toBeNull()
    expect(grossMarginPercent(Number.POSITIVE_INFINITY, 1)).toBeNull()
  })

  test('free upstream cost still yields profit and a full margin', () => {
    expect(grossProfitUsd(2, 0)).toBe(2)
    expect(grossMarginPercent(2, 0)).toBe(100)
  })

  test('returns null when the margin overflows finite numbers', () => {
    expect(grossMarginPercent(1e-323, Number.MAX_VALUE)).toBeNull()
  })
})
