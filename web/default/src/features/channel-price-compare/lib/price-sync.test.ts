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
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

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
    assert.equal(result?.source, 'detected')
    assert.equal(result?.input, 2)
    assert.equal(result?.output, 8)
  })

  test('prefers a manual purchase price even when detection is available', () => {
    const result = resolveSyncBasis(
      channel({ price_source: 'manual', detected_available: true })
    )
    assert.equal(result?.source, 'manual')
    assert.equal(result?.input, 3)
    assert.equal(result?.output, 9)
  })

  test('falls back to manual purchase price without detection', () => {
    const result = resolveSyncBasis(
      channel({ detected_available: false, price_source: 'manual' })
    )
    assert.equal(result?.source, 'manual')
    assert.equal(result?.input, 3)
  })

  test('returns null when neither manual nor detected pricing is available', () => {
    assert.equal(
      resolveSyncBasis(
        channel({ price_source: 'missing', detected_available: false })
      ),
      null
    )
  })

  test('returns null when price is not maintained', () => {
    assert.equal(resolveSyncBasis(channel({ status: 'unknown' })), null)
  })
})

describe('shouldUseOfficialPricing', () => {
  test('keeps a manual purchase price ahead of the official source marker', () => {
    const manualBasis = resolveSyncBasis(
      channel({ price_source: 'manual', uses_official_pricing: true })
    )
    assert.equal(manualBasis?.source, 'manual')
    assert.equal(
      shouldUseOfficialPricing(
        channel({ price_source: 'manual', uses_official_pricing: true }),
        manualBasis
      ),
      false
    )
  })

  test('honors explicit source markers before legacy fallbacks', () => {
    const detectedBasis = resolveSyncBasis(channel({}))
    assert.equal(
      shouldUseOfficialPricing(
        channel({ uses_official_pricing: false, billing_mode: 'tiered_expr' }),
        detectedBasis
      ),
      false
    )
    assert.equal(
      shouldUseOfficialPricing(
        channel({
          uses_official_pricing: false,
          status: 'unknown',
          detected_available: false,
        }),
        null
      ),
      false
    )
    assert.equal(
      shouldUseOfficialPricing(
        channel({ uses_official_pricing: true }),
        detectedBasis
      ),
      false
    )
  })

  test('uses official pricing when no manual or detected basis is available', () => {
    const missingChannel = channel({
      price_source: 'missing',
      detected_available: false,
      uses_official_pricing: true,
    })
    const missingBasis = resolveSyncBasis(missingChannel)
    assert.equal(missingBasis, null)
    assert.equal(shouldUseOfficialPricing(missingChannel, missingBasis), true)
  })

  test('requires an explicit official marker for a ratio channel without a basis', () => {
    const missingChannel = channel({
      price_source: 'missing',
      detected_available: false,
      uses_official_pricing: undefined,
      billing_mode: 'ratio',
    })
    const missingBasis = resolveSyncBasis(missingChannel)
    assert.equal(missingBasis, null)
    assert.equal(shouldUseOfficialPricing(missingChannel, missingBasis), false)
  })

  test('does not infer official pricing from a legacy tiered billing mode', () => {
    assert.equal(
      shouldUseOfficialPricing(
        channel({
          uses_official_pricing: undefined,
          billing_mode: 'tiered_expr',
        }),
        resolveSyncBasis(channel({}))
      ),
      false
    )
    assert.equal(
      shouldUseOfficialPricing(
        channel({
          uses_official_pricing: undefined,
          status: 'unknown',
          detected_available: false,
        }),
        null
      ),
      false
    )
  })

  test('routes a persisted Models.dev source through the explicit official marker', () => {
    const persistedOfficialChannel = channel({
      price_source: 'models_dev',
      detected_available: false,
      uses_official_pricing: true,
      billing_mode: 'tiered_expr',
    })

    const persistedBasis = resolveSyncBasis(persistedOfficialChannel)
    assert.equal(persistedBasis, null)
    assert.equal(
      shouldUseOfficialPricing(persistedOfficialChannel, persistedBasis),
      true
    )
  })
})

describe('computeSyncRatios', () => {
  test('derives ratios from cost, markup and group ratio', () => {
    // cost in 2 / out 8, markup 100% -> sell 4 / 16; group 1 -> modelRatio 2
    const plan = computeSyncRatios(basis({}), 100, 1)
    assert.ok(plan)
    assert.equal(plan.modelRatio, 2)
    assert.equal(plan.completionRatio, 4)
    assert.equal(plan.cacheRatio, 0.1)
    assert.equal(plan.createCacheRatio, 1)
    assert.equal(plan.sellInput, 4)
    assert.equal(plan.sellOutput, 16)
  })

  test('divides the group ratio out of the model ratio', () => {
    const plan = computeSyncRatios(basis({}), 100, 2)
    assert.ok(plan)
    assert.equal(plan.modelRatio, 1)
    // relative ratios do not depend on markup or group ratio
    assert.equal(plan.completionRatio, 4)
  })

  test('uses the configured quota scale when deriving the model ratio', () => {
    const plan = computeSyncRatios(basis({}), 100, 1, undefined, 1_000_000)
    assert.ok(plan)
    assert.equal(plan.modelRatio, 4)
    assert.equal(plan.sellInput, 4)
  })

  test('zero markup prices at cost', () => {
    const plan = computeSyncRatios(basis({}), 0, 1)
    assert.ok(plan)
    assert.equal(plan.modelRatio, 1)
    assert.equal(plan.sellInput, 2)
  })

  test('marks up 0, 100 and 200 to cost, double and triple', () => {
    const atCost = computeSyncRatios(basis({}), 0, 1)
    assert.ok(atCost)
    assert.equal(atCost.sellInput, 2)
    const doubled = computeSyncRatios(basis({}), 100, 1)
    assert.ok(doubled)
    assert.equal(doubled.sellInput, 4)
    const tripled = computeSyncRatios(basis({}), 200, 1)
    assert.ok(tripled)
    assert.equal(tripled.sellInput, 6)
    const decimal = computeSyncRatios(basis({}), 99.99, 1)
    assert.ok(decimal)
    assert.ok(Number.isFinite(decimal.sellInput))
    assert.ok(Number.isFinite(decimal.sellOutput))
    assert.ok(decimal.sellInput > atCost.sellInput)
  })

  test('treats an empty target markup as invalid instead of zero', () => {
    assert.equal(parseTargetMarkup(''), null)
    assert.equal(parseTargetMarkup('   '), null)
    assert.equal(parseTargetMarkup('0'), 0)
  })

  test('accepts any finite non-negative markup and rejects negatives and NaN', () => {
    assert.equal(parseTargetMarkup('99'), 99)
    assert.equal(parseTargetMarkup('99.99'), 99.99)
    assert.equal(parseTargetMarkup('100'), 100)
    assert.equal(parseTargetMarkup('200'), 200)
    assert.equal(parseTargetMarkup('-1'), null)
    assert.equal(parseTargetMarkup('abc'), null)
  })

  test('writes zero ratios when the upstream does not charge', () => {
    const plan = computeSyncRatios(
      basis({ output: 0, cacheRead: 0, cacheWrite: 0 }),
      100,
      1
    )
    assert.ok(plan)
    assert.equal(plan.completionRatio, 0)
    assert.equal(plan.cacheRatio, 0)
    assert.equal(plan.createCacheRatio, 0)
  })

  test('rejects invalid markup and non-positive cost', () => {
    assert.equal(computeSyncRatios(basis({}), -1, 1), null)
    assert.equal(computeSyncRatios(basis({}), Number.NaN, 1), null)
    assert.equal(computeSyncRatios(basis({ input: 0 }), 100, 1), null)
  })

  test('rejects a non-positive or invalid group ratio', () => {
    assert.equal(computeSyncRatios(basis({}), 100, 0), null)
    assert.equal(computeSyncRatios(basis({}), 100, -1), null)
    assert.equal(computeSyncRatios(basis({}), 100, Number.NaN), null)
  })

  test('rejects a non-positive or invalid quota scale', () => {
    assert.equal(computeSyncRatios(basis({}), 100, 1, undefined, 0), null)
    assert.equal(computeSyncRatios(basis({}), 100, 1, undefined, -1), null)
    assert.equal(
      computeSyncRatios(basis({}), 100, 1, undefined, Number.NaN),
      null
    )
  })

  test('rejects calculations that overflow finite pricing ratios', () => {
    assert.equal(
      computeSyncRatios(basis({ input: Number.MAX_VALUE }), 100, 1e-300),
      null
    )
  })

  test('honors a locked completion ratio without dropping below target markup', () => {
    const plan = computeSyncRatios(basis({ output: 12 }), 100, 1, 4)
    assert.ok(plan)
    assert.equal(plan.completionRatioLocked, true)
    assert.equal(plan.modelRatio, 3)
    assert.equal(plan.completionRatio, 4)
    assert.equal(plan.sellInput, 6)
    assert.equal(plan.sellOutput, 24)
    assert.equal(plan.cacheRatio, 0.066667)
    assert.equal(plan.createCacheRatio, 0.666667)
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

    assert.equal(result.kind, 'ready')
    if (result.kind !== 'ready') return
    assert.equal(result.plan.billingMode, 'ratio')
    assert.equal(result.plan.input, 1.5)
    assert.equal(result.plan.output, 7.5)
    assert.equal(result.plan.cacheRead, 0.15)
    assert.equal(result.plan.cacheWrite, 1.875)
    assert.equal(result.plan.sellInput, 76.5)
    assert.equal(result.plan.sellOutput, 382.5)
    assert.deepEqual(result.plan.tiers, [])
    assert.equal('billingExpression' in result.plan, false)

    const request = buildOfficialSyncRequest('grok-4.6', 31, 'xai', result.plan)
    assert.deepEqual(request, {
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
    assert.equal(similar.billingMode, 'tiered_expr')
    assert.equal(similar.tiers.length, 2)
    assert.match(similar.billingExpression, /len < 200000/)
    assert.ok(other)
    assert.equal(other.billingMode, 'tiered_expr')
    assert.equal(other.tiers.length, 1)
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

    assert.equal(result.kind, 'invalid-source')
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

    assert.equal(result.kind, 'invalid-source')
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
    assert.equal(zeroInput.kind, 'invalid-source')

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
    assert.equal(invalidTier.kind, 'invalid-source')

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
    assert.equal(overflow.kind, 'overflow')
  })

  test('classifies a non-finite billing coefficient from a tiny group ratio as overflow', () => {
    const result = computeOfficialSyncPlanResult(
      officialModel,
      30,
      Number.MIN_VALUE
    )

    assert.equal(result.kind, 'overflow')
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

    assert.equal(result.kind, 'overflow')
  })

  test('prices every context tier at a 30 percent markup', () => {
    const plan = computeOfficialSyncPlan(officialModel, 30, 1)
    assert.ok(plan)
    assert.equal(plan.billingMode, 'tiered_expr')
    assert.equal(plan.sellInput, 5 * 1.3)
    assert.equal(plan.sellOutput, 30 * 1.3)
    assert.equal(plan.sellCacheRead, 0.5 * 1.3)
    assert.equal(plan.sellCacheWrite, 6.25 * 1.3)
    assert.equal(plan.tiers[0].name, 'context_272000')
    assert.equal(plan.tiers[0].sellInput, 10 * 1.3)
    assert.equal(plan.tiers[0].sellOutput, 45 * 1.3)
    assert.match(plan.billingExpression, /len < 272000/)
    assert.ok(plan.billingExpression.includes('p * 3.25'))
    assert.ok(plan.billingExpression.includes('tier("context_272000"'))
  })

  test('marks up 0, 100 and 200 to cost, double and triple official prices', () => {
    const atCost = computeOfficialSyncPlan(officialModel, 0, 1)
    assert.ok(atCost)
    assert.equal(atCost.sellInput, 5)
    assert.equal(atCost.sellOutput, 30)
    const doubled = computeOfficialSyncPlan(officialModel, 100, 1)
    assert.ok(doubled)
    assert.equal(doubled.sellInput, 10)
    assert.equal(doubled.sellOutput, 60)
    const tripled = computeOfficialSyncPlan(officialModel, 200, 1)
    assert.ok(tripled)
    assert.equal(tripled.sellInput, 15)
    assert.equal(tripled.sellOutput, 90)
    const decimal = computeOfficialSyncPlan(officialModel, 99.99, 1)
    assert.ok(decimal)
    assert.ok(Number.isFinite(decimal.sellInput))
    assert.ok(Number.isFinite(decimal.sellOutput))
  })

  test('builds an atomic official-price update request', () => {
    const plan = computeOfficialSyncPlan(officialModel, 30, 1)
    assert.ok(plan)

    const request = buildOfficialSyncRequest('gpt-5.6-sol', 31, 'openai', plan)

    assert.equal(request.billing_mode, 'tiered_expr')
    assert.equal(request.channel_id, 31)
    assert.equal(request.upstream_provider, 'openai')
    assert.equal(request.purchase_price.source, 'models_dev')
    assert.equal(request.purchase_price.input, 5)
    assert.deepEqual(request.purchase_price.tiers, [
      {
        name: 'context_272000',
        context_threshold: 272_000,
        input: 10,
        output: 45,
        cache_read: 1,
        cache_write: 12.5,
      },
    ])
  })

  test('rejects invalid markup, group ratio, and missing official pricing', () => {
    assert.equal(computeOfficialSyncPlan(officialModel, -1, 1), null)
    assert.equal(computeOfficialSyncPlan(officialModel, Number.NaN, 1), null)
    assert.equal(computeOfficialSyncPlan(officialModel, 30, 0), null)
    assert.equal(
      computeOfficialSyncPlan(
        { ...officialModel, models_dev_pricing: undefined },
        30,
        1
      ),
      null
    )
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
    assert.equal(overflowCache, null)

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
    assert.equal(overflowTier, null)
  })
})

describe('buildSyncRequest', () => {
  test('builds a model-level pricing update', () => {
    const plan = computeSyncRatios(basis({}), 100, 1)
    assert.ok(plan)
    assert.deepEqual(buildSyncRequest('m', plan), {
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
    assert.deepEqual(buildSyncRequest('m', plan), {
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
    assert.deepEqual(
      parseCompletionRatioMeta(
        '{"m":{"ratio":4,"locked":true},"bad":{"ratio":"x","locked":true}}'
      ),
      { m: { ratio: 4, locked: true } }
    )
    assert.deepEqual(parseCompletionRatioMeta(undefined), {})
    assert.deepEqual(parseCompletionRatioMeta('[1,2]'), {})
  })
})

describe('parseNumberRecord', () => {
  test('parses JSON maps and tolerates invalid input', () => {
    assert.deepEqual(parseNumberRecord('{"a":1}'), { a: 1 })
    assert.deepEqual(parseNumberRecord(undefined), {})
    assert.deepEqual(parseNumberRecord('not json'), {})
    assert.deepEqual(parseNumberRecord('[1,2]'), {})
  })
})

describe('cost-profit-rate helpers', () => {
  test('calculates 0, 100, and 455.56 percent', () => {
    assert.equal(currentCostProfitRatePercent(1, 1), 0)
    assert.equal(currentCostProfitRatePercent(2, 1), 100)
    assert.equal(currentCostProfitRatePercent(5.5556, 1), 455.56)
  })

  test('parses the cost-profit rate and rejects negatives', () => {
    assert.equal(parseTargetCostProfitRate('455.56'), 455.56)
    assert.equal(parseTargetCostProfitRate('-0.01'), null)
  })

  test('official 5/30 at multiplier 0.25 against 9/50 selling defaults to 566.67', () => {
    assert.equal(
      defaultTargetMarkupPercent({
        sellingInput: 9,
        sellingOutput: 50,
        costInput: 5 * 0.25,
        costOutput: 30 * 0.25,
      }),
      566.67
    )
  })

  test('detected 2/8 against 6/20 selling defaults to 150', () => {
    assert.equal(
      defaultTargetMarkupPercent({
        sellingInput: 6,
        sellingOutput: 20,
        costInput: 2,
        costOutput: 8,
      }),
      150
    )
  })

  test('rounds the lower markup to at most two decimals', () => {
    // input markup 566.66... is the lower one and rounds to 566.67
    assert.equal(
      defaultTargetMarkupPercent({
        sellingInput: 20,
        sellingOutput: 100,
        costInput: 3,
        costOutput: 5,
      }),
      566.67
    )
  })

  test('uses a current markup of 99 as the dialog default', () => {
    assert.equal(currentMarkupPercent(199, 100), 99)
    assert.equal(
      defaultTargetMarkupPercent({
        sellingInput: 199,
        sellingOutput: 199,
        costInput: 100,
        costOutput: 100,
      }),
      99
    )
  })

  test('keeps markups of 100 and above as dialog defaults', () => {
    assert.equal(
      defaultTargetMarkupPercent({
        sellingInput: 200,
        sellingOutput: 200,
        costInput: 100,
        costOutput: 100,
      }),
      100
    )
    assert.equal(
      defaultTargetMarkupPercent({
        sellingInput: 300,
        sellingOutput: 300,
        costInput: 100,
        costOutput: 100,
      }),
      200
    )
  })

  test('returns null when the current markup is negative', () => {
    assert.equal(currentMarkupPercent(1, 2), -50)
    // the lower class controls: a negative input markup must not be discarded
    assert.equal(
      defaultTargetMarkupPercent({
        sellingInput: 1,
        sellingOutput: 10,
        costInput: 2,
        costOutput: 4,
      }),
      null
    )
  })

  test('returns null when the markup overflows finite numbers', () => {
    assert.equal(currentMarkupPercent(Number.MAX_VALUE, 1), null)
  })

  test('returns null when the markup cannot be computed', () => {
    assert.equal(currentMarkupPercent(Number.NaN, 2), null)
    assert.equal(currentMarkupPercent(2, 0), null)
    assert.equal(currentMarkupPercent(2, -1), null)
    assert.equal(currentMarkupPercent(-1, 2), null)
    // both input and output are required to establish the lower markup
    assert.equal(
      defaultTargetMarkupPercent({
        sellingInput: 0,
        sellingOutput: 20,
        costInput: 2,
        costOutput: 8,
      }),
      null
    )

    // a non-positive output cost cannot anchor a markup
    assert.equal(
      defaultTargetMarkupPercent({
        sellingInput: 20,
        sellingOutput: 20,
        costInput: 8,
        costOutput: 0,
      }),
      null
    )
  })
})

describe('grossProfitUsd / grossMarginPercent', () => {
  test('screenshot example: cost 1.25/7.50, sale 8.333375/50.00025 -> profit 7.083375/42.50025, margin 85.0%', () => {
    assert.equal(grossProfitUsd(8.333375, 1.25), 7.083375)
    assert.equal(grossProfitUsd(50.00025, 7.5), 42.50025)
    assert.equal(grossMarginPercent(8.333375, 1.25), 85.000074999625)
    assert.equal(grossMarginPercent(50.00025, 7.5), 85.000074999625)
  })

  test('keeps negative profit and negative margin when price is below cost', () => {
    assert.equal(grossProfitUsd(1, 2), -1)
    assert.equal(grossProfitUsd(0, 2), -2)
    assert.equal(grossMarginPercent(1, 2), -100)
  })

  test('has no margin on a zero or negative selling price', () => {
    assert.equal(grossMarginPercent(0, 2), null)
    assert.equal(grossMarginPercent(-1, 2), null)
    // a zero sale price still yields a finite loss as gross profit
    assert.equal(grossProfitUsd(0, 2), -2)
  })

  test('returns null for non-finite inputs', () => {
    assert.equal(grossProfitUsd(Number.NaN, 1), null)
    assert.equal(grossProfitUsd(1, Number.NaN), null)
    assert.equal(grossProfitUsd(Number.POSITIVE_INFINITY, 1), null)
    assert.equal(grossMarginPercent(Number.NaN, 1), null)
    assert.equal(grossMarginPercent(1, Number.NaN), null)
    assert.equal(grossMarginPercent(Number.POSITIVE_INFINITY, 1), null)
  })

  test('free upstream cost still yields profit and a full margin', () => {
    assert.equal(grossProfitUsd(2, 0), 2)
    assert.equal(grossMarginPercent(2, 0), 100)
  })

  test('returns null when the margin overflows finite numbers', () => {
    assert.equal(grossMarginPercent(1e-323, Number.MAX_VALUE), null)
  })
})
