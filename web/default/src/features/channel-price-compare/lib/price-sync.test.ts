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
  computeSyncRatios,
  currentMarginPercent,
  defaultTargetMarginPercent,
  shouldUseOfficialPricing,
  parseCompletionRatioMeta,
  parseTargetMargin,
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
  test('prefers detected prices when available', () => {
    const result = resolveSyncBasis(channel({}))
    assert.equal(result?.source, 'detected')
    assert.equal(result?.input, 2)
    assert.equal(result?.output, 8)
  })

  test('falls back to manual purchase price without detection', () => {
    const result = resolveSyncBasis(
      channel({ detected_available: false, price_source: 'manual' })
    )
    assert.equal(result?.source, 'manual')
    assert.equal(result?.input, 3)
  })

  test('returns null when price is not maintained', () => {
    assert.equal(resolveSyncBasis(channel({ status: 'unknown' })), null)
  })
})

describe('shouldUseOfficialPricing', () => {
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
      true
    )
  })

  test('preserves the previous routing only for unmarked legacy rows', () => {
    assert.equal(
      shouldUseOfficialPricing(
        channel({
          uses_official_pricing: undefined,
          billing_mode: 'tiered_expr',
        }),
        resolveSyncBasis(channel({}))
      ),
      true
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
      true
    )
  })
})

describe('computeSyncRatios', () => {
  test('derives ratios from cost, margin and group ratio', () => {
    // cost in 2 / out 8, margin 50% -> sell 4 / 16; group 1 -> modelRatio 2
    const plan = computeSyncRatios(basis({}), 50, 1)
    assert.ok(plan)
    assert.equal(plan.modelRatio, 2)
    assert.equal(plan.completionRatio, 4)
    assert.equal(plan.cacheRatio, 0.1)
    assert.equal(plan.createCacheRatio, 1)
    assert.equal(plan.sellInput, 4)
    assert.equal(plan.sellOutput, 16)
  })

  test('divides the group ratio out of the model ratio', () => {
    const plan = computeSyncRatios(basis({}), 50, 2)
    assert.ok(plan)
    assert.equal(plan.modelRatio, 1)
    // relative ratios do not depend on margin or group ratio
    assert.equal(plan.completionRatio, 4)
  })

  test('uses the configured quota scale when deriving the model ratio', () => {
    const plan = computeSyncRatios(basis({}), 50, 1, undefined, 1_000_000)
    assert.ok(plan)
    assert.equal(plan.modelRatio, 4)
    assert.equal(plan.sellInput, 4)
  })

  test('zero margin prices at cost', () => {
    const plan = computeSyncRatios(basis({}), 0, 1)
    assert.ok(plan)
    assert.equal(plan.modelRatio, 1)
    assert.equal(plan.sellInput, 2)
  })

  test('treats an empty target margin as invalid instead of zero', () => {
    assert.equal(parseTargetMargin(''), null)
    assert.equal(parseTargetMargin('   '), null)
    assert.equal(parseTargetMargin('0'), 0)
  })

  test('writes zero ratios when the upstream does not charge', () => {
    const plan = computeSyncRatios(
      basis({ output: 0, cacheRead: 0, cacheWrite: 0 }),
      50,
      1
    )
    assert.ok(plan)
    assert.equal(plan.completionRatio, 0)
    assert.equal(plan.cacheRatio, 0)
    assert.equal(plan.createCacheRatio, 0)
  })

  test('rejects invalid margin and non-positive cost', () => {
    assert.equal(computeSyncRatios(basis({}), -1, 1), null)
    assert.equal(computeSyncRatios(basis({}), 95, 1), null)
    assert.equal(computeSyncRatios(basis({}), Number.NaN, 1), null)
    assert.equal(computeSyncRatios(basis({ input: 0 }), 50, 1), null)
  })

  test('rejects a non-positive or invalid group ratio', () => {
    assert.equal(computeSyncRatios(basis({}), 50, 0), null)
    assert.equal(computeSyncRatios(basis({}), 50, -1), null)
    assert.equal(computeSyncRatios(basis({}), 50, Number.NaN), null)
  })

  test('rejects a non-positive or invalid quota scale', () => {
    assert.equal(computeSyncRatios(basis({}), 50, 1, undefined, 0), null)
    assert.equal(computeSyncRatios(basis({}), 50, 1, undefined, -1), null)
    assert.equal(
      computeSyncRatios(basis({}), 50, 1, undefined, Number.NaN),
      null
    )
  })

  test('rejects calculations that overflow finite pricing ratios', () => {
    assert.equal(
      computeSyncRatios(basis({ input: Number.MAX_VALUE }), 94, 1e-300),
      null
    )
  })

  test('honors a locked completion ratio without dropping below target margin', () => {
    const plan = computeSyncRatios(basis({ output: 12 }), 50, 1, 4)
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
  test('prices every context tier at a 30 percent gross margin', () => {
    const plan = computeOfficialSyncPlan(officialModel, 30, 1)
    assert.ok(plan)
    assert.equal(plan.sellInput, 5 / 0.7)
    assert.equal(plan.sellOutput, 30 / 0.7)
    assert.equal(plan.sellCacheRead, 0.5 / 0.7)
    assert.equal(plan.sellCacheWrite, 6.25 / 0.7)
    assert.equal(plan.tiers[0].name, 'context_272000')
    assert.equal(plan.tiers[0].sellInput, 10 / 0.7)
    assert.equal(plan.tiers[0].sellOutput, 45 / 0.7)
    assert.match(plan.billingExpression, /len < 272000/)
    assert.ok(plan.billingExpression.includes('p * 3.571428571'))
    assert.ok(plan.billingExpression.includes('tier("context_272000"'))
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

  test('rejects invalid margin, group ratio, and missing official pricing', () => {
    assert.equal(computeOfficialSyncPlan(officialModel, 95, 1), null)
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
})

describe('buildSyncRequest', () => {
  test('builds a model-level pricing update', () => {
    const plan = computeSyncRatios(basis({}), 50, 1)
    assert.ok(plan)
    assert.deepEqual(buildSyncRequest('m', plan), {
      model_name: 'm',
      model_ratio: 2,
      completion_ratio: 4,
      cache_ratio: 0.1,
      create_cache_ratio: 1,
    })
  })

  test('omits an ignored completion ratio when it is locked', () => {
    const plan = computeSyncRatios(basis({ output: 12 }), 50, 1, 4)
    assert.ok(plan)
    assert.deepEqual(buildSyncRequest('m', plan), {
      model_name: 'm',
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

describe('currentMarginPercent / defaultTargetMarginPercent', () => {
  test('official 5/30 at multiplier 0.25 against 9/50 selling defaults to 85', () => {
    assert.equal(
      defaultTargetMarginPercent({
        sellingInput: 9,
        sellingOutput: 50,
        costInput: 5 * 0.25,
        costOutput: 30 * 0.25,
      }),
      85
    )
  })

  test('detected 2/8 against 6/20 selling defaults to 60', () => {
    assert.equal(
      defaultTargetMarginPercent({
        sellingInput: 6,
        sellingOutput: 20,
        costInput: 2,
        costOutput: 8,
      }),
      60
    )
  })

  test('rounds the lower margin to at most two decimals', () => {
    // input margin 93.055... is the lower one and rounds to 93.06
    assert.equal(
      defaultTargetMarginPercent({
        sellingInput: 18,
        sellingOutput: 100,
        costInput: 1.25,
        costOutput: 6,
      }),
      93.06
    )
  })

  test('falls back when rounding would cross the 95 percent limit', () => {
    assert.equal(
      defaultTargetMarginPercent({
        sellingInput: 100,
        sellingOutput: 100,
        costInput: 5.005,
        costOutput: 5.005,
      }),
      null
    )
  })

  test('returns null when the current margin is out of the valid range', () => {
    assert.equal(currentMarginPercent(10, 0.1), 99)
    assert.equal(
      defaultTargetMarginPercent({
        sellingInput: 10,
        sellingOutput: 10,
        costInput: 0.1,
        costOutput: 0.1,
      }),
      null
    )
    // selling below cost is a negative margin
    // the lower class controls: a negative input margin must not be discarded
    assert.equal(
      defaultTargetMarginPercent({
        sellingInput: 1,
        sellingOutput: 10,
        costInput: 2,
        costOutput: 4,
      }),
      null
    )
  })

  test('returns null when the margin cannot be computed', () => {
    assert.equal(currentMarginPercent(0, 2), null)
    assert.equal(currentMarginPercent(2, 0), 100)
    assert.equal(currentMarginPercent(Number.NaN, 2), null)
    // both input and output are required to establish the lower margin
    assert.equal(
      defaultTargetMarginPercent({
        sellingInput: 0,
        sellingOutput: 20,
        costInput: 2,
        costOutput: 8,
      }),
      null
    )

    // A free output class has a valid 100% margin; the lower input margin wins.
    assert.equal(
      defaultTargetMarginPercent({
        sellingInput: 20,
        sellingOutput: 20,
        costInput: 8,
        costOutput: 0,
      }),
      60
    )
  })
})
