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
import { describe, expect, test } from 'vitest'

import type { PriceCompareChannel, PriceCompareModel } from '../types'
import {
  autotuneRows,
  buildRatioSyncRequest,
  ceilToStep,
  effectiveCost,
  fillDetectedCosts,
  isPriceDirty,
  isRowDirty,
  mergeModelPriceIntoSettings,
  type RatioOptionSnapshot,
  suggestSalePrices,
  unwriteableReason,
  type WorkbenchRow,
  workbenchMargin,
  workbenchRowFromChannel,
  workbenchRowKey,
} from './workbench'

function makeChannel(
  overrides: Partial<PriceCompareChannel> = {}
): PriceCompareChannel {
  return {
    channel_id: 7,
    channel_name: 'upstream-a',
    upstream_group: '',
    upstream_model: 'm',
    priority: 0,
    upstream_price_multiplier: 1,
    weight: 0,
    routing_role: 'primary',
    status: 'ok',
    status_reason: '',
    price_source: 'manual',
    price_changed: false,
    detected_available: false,
    uses_fixed_price: false,
    fixed_price: 0,
    billing_mode: 'ratio',
    local_input: 4,
    local_output: 16,
    local_cache_read: 0.4,
    local_cache_write: 5,
    upstream_input: 2,
    upstream_output: 8,
    upstream_cache_read: 0.2,
    upstream_cache_write: 0,
    detected_input: 0,
    detected_output: 0,
    detected_cache_read: 0,
    detected_cache_write: 0,
    margin_input: 50,
    margin_output: 50,
    today: {
      requests: 0,
      revenue: 0,
      upstream_cost: 0,
      profit: 0,
      margin: 0,
      cost_available: true,
    },
    total: {
      requests: 0,
      revenue: 0,
      upstream_cost: 0,
      profit: 0,
      margin: 0,
      cost_available: true,
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
  }
}

const MODEL: PriceCompareModel = { model_name: 'm', channels: [] }

function makeRow(overrides: Partial<WorkbenchRow> = {}): WorkbenchRow {
  return {
    key: workbenchRowKey('m', 7),
    modelName: 'm',
    channelId: 7,
    channelName: 'upstream-a',
    billingMode: 'ratio',
    usesFixedPrice: false,
    status: 'ok',
    localInput: 4,
    localOutput: 16,
    costInput: 2,
    costOutput: 8,
    detected: null,
    margin: 50,
    risk: false,
    todayProfit: 0,
    ...overrides,
  }
}

describe('workbenchRowFromChannel', () => {
  test('derives cost and margin from the resolved upstream basis', () => {
    const row = workbenchRowFromChannel(MODEL, makeChannel())
    expect(row.costInput).toBe(2)
    expect(row.costOutput).toBe(8)
    expect(row.margin).toBe(50)
    expect(row.risk).toBe(false)
  })

  test('missing price leaves cost and margin unknown and flags risk', () => {
    const row = workbenchRowFromChannel(
      MODEL,
      makeChannel({
        price_source: 'missing',
        upstream_input: 0,
        upstream_output: 0,
        margin_input: 0,
        margin_output: 0,
        recommendations: ['missing_price'],
      })
    )
    expect(row.costInput).toBeNull()
    expect(row.margin).toBeNull()
    expect(row.risk).toBe(true)
  })

  test('margin below 15 percent flags risk without recommendations', () => {
    const row = workbenchRowFromChannel(
      MODEL,
      makeChannel({ margin_input: 10, margin_output: 40 })
    )
    expect(row.margin).toBe(10)
    expect(row.risk).toBe(true)
  })
})

describe('workbenchMargin', () => {
  test('recomputes from staged sale prices', () => {
    const row = makeRow()
    const margin = workbenchMargin(row, { saleInput: '5', saleOutput: '20' })
    expect(margin).toBe(60)
  })

  test('recomputes from a staged cost', () => {
    const row = makeRow({ costInput: null, costOutput: null, margin: null })
    const margin = workbenchMargin(row, {
      cost: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0, via: 'manual' },
    })
    expect(margin).toBe(75)
  })

  test('returns null while cost stays unknown', () => {
    const row = makeRow({ costInput: null, costOutput: null, margin: null })
    expect(workbenchMargin(row, undefined)).toBeNull()
  })
})

describe('dirty tracking', () => {
  test('sale equal to local price is not dirty', () => {
    const row = makeRow()
    expect(isPriceDirty(row, { saleInput: '4' })).toBe(false)
    expect(isPriceDirty(row, { saleInput: '5' })).toBe(true)
    expect(isRowDirty(row, { saleInput: '4' })).toBe(false)
  })

  test('staged cost alone makes the row dirty', () => {
    const row = makeRow()
    expect(
      isRowDirty(row, {
        cost: {
          input: 2,
          output: 8,
          cacheRead: 0,
          cacheWrite: 0,
          via: 'detected',
        },
      })
    ).toBe(true)
  })
})

describe('unwriteableReason', () => {
  test('fixed price and tiered channels are excluded', () => {
    expect(unwriteableReason(makeRow({ usesFixedPrice: true }))).toBe('fixed')
    expect(unwriteableReason(makeRow({ billingMode: 'tiered_expr' }))).toBe(
      'tiered'
    )
    expect(unwriteableReason(makeRow())).toBeNull()
    // unknown cost status never blocks writes — staging a cost fixes it
    expect(unwriteableReason(makeRow({ status: 'unknown' }))).toBeNull()
  })
})

describe('ceilToStep', () => {
  test('rounds up to the step without dropping below the target', () => {
    expect(ceilToStep(4.2857, 0.1)).toBe(4.3)
    expect(ceilToStep(4.3, 0.1)).toBe(4.3)
    expect(ceilToStep(4.01, 0.25)).toBe(4.25)
    expect(ceilToStep(4.2857, 0)).toBe(4.2857)
  })
})

describe('suggestSalePrices', () => {
  test('derives prices from cost and target margin with rounding', () => {
    const suggestion = suggestSalePrices({ input: 3, output: 9 }, 30, 0.1)
    expect(suggestion).toEqual({ saleInput: 4.3, saleOutput: 12.9 })
  })

  test('respects a locked completion ratio', () => {
    const suggestion = suggestSalePrices({ input: 3, output: 9 }, 30, 0.1, 5)
    expect(suggestion).toEqual({ saleInput: 4.3, saleOutput: 21.5 })
  })

  test('rejects invalid targets and non-positive costs', () => {
    expect(suggestSalePrices({ input: 3, output: 9 }, 100, 0.1)).toBeNull()
    expect(suggestSalePrices({ input: 0, output: 9 }, 30, 0.1)).toBeNull()
    expect(suggestSalePrices({ input: 3, output: 0 }, 30, 0.1)).toBeNull()
  })
})

describe('autotuneRows', () => {
  const lowMarginRow = makeRow({
    key: 'low|7',
    margin: 20,
    localInput: 3.75,
    localOutput: 11.25,
    costInput: 3,
    costOutput: 9,
  })
  const fineRow = makeRow({ key: 'fine|8', channelId: 8, margin: 60 })
  const tieredRow = makeRow({
    key: 'tiered|9',
    channelId: 9,
    billingMode: 'tiered_expr',
  })
  const noCostRow = makeRow({
    key: 'nocost|10',
    channelId: 10,
    costInput: null,
    costOutput: null,
    margin: null,
  })

  test('scope below tunes only rows under the target', () => {
    const result = autotuneRows(
      [lowMarginRow, fineRow, tieredRow, noCostRow],
      {},
      'below',
      30,
      0.1
    )
    expect(result.tuned).toBe(1)
    expect(result.already).toBe(1)
    expect(result.skipped).toBe(2)
    expect(result.changes['low|7']).toEqual({
      saleInput: '4.3',
      saleOutput: '12.9',
      targetMargin: '30',
    })
  })

  test('scope all tunes every writeable row with known cost', () => {
    const result = autotuneRows([lowMarginRow, fineRow], {}, 'all', 30, 0.1)
    expect(result.tuned).toBe(2)
    expect(result.already).toBe(0)
  })

  test('scope risk only touches risk rows', () => {
    const result = autotuneRows(
      [{ ...lowMarginRow, risk: true }, fineRow],
      {},
      'risk',
      30,
      0.1
    )
    expect(result.tuned).toBe(1)
    expect(Object.keys(result.changes)).toEqual(['low|7'])
  })

  test('staged costs make missing-price rows tunable', () => {
    const result = autotuneRows(
      [noCostRow],
      {
        'nocost|10': {
          cost: {
            input: 3,
            output: 9,
            cacheRead: 0,
            cacheWrite: 0,
            via: 'manual',
          },
        },
      },
      'below',
      30,
      0.1
    )
    expect(result.tuned).toBe(1)
    expect(result.changes['nocost|10'].cost?.via).toBe('manual')
  })
})

describe('buildRatioSyncRequest', () => {
  const snapshot: RatioOptionSnapshot = {
    groupRatio: 2,
    modelRatio: 1,
    completionRatio: 4,
    cacheRatio: 0.1,
    createCacheRatio: 1.25,
    lockedCompletionRatio: undefined,
    hasFixedPrice: false,
  }

  test('converts staged USD prices to ratios and passes cache ratios through', () => {
    const result = buildRatioSyncRequest(
      makeRow(),
      { saleInput: '5', saleOutput: '25' },
      snapshot
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.model_ratio).toBe(5 / 2 / 2)
    expect(result.request.completion_ratio).toBe(5)
    expect(result.request.cache_ratio).toBe(0.1)
    expect(result.request.create_cache_ratio).toBe(1.25)
  })

  test('unchanged prices pass the current ratios through', () => {
    const result = buildRatioSyncRequest(makeRow(), {}, snapshot)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.model_ratio).toBe(1)
    expect(result.request.completion_ratio).toBe(4)
  })

  test('rejects when the online price drifted from the staged base', () => {
    const result = buildRatioSyncRequest(
      makeRow(),
      { saleInput: '5' },
      { ...snapshot, modelRatio: 1.5 }
    )
    expect(result).toEqual({ ok: false, reason: 'drift', detail: '6' })
  })

  test('rejects fixed-price models and missing current ratios', () => {
    expect(
      buildRatioSyncRequest(
        makeRow(),
        {},
        { ...snapshot, hasFixedPrice: true }
      )
    ).toEqual({ ok: false, reason: 'fixed-price' })
    expect(
      buildRatioSyncRequest(
        makeRow(),
        {},
        { ...snapshot, modelRatio: undefined }
      )
    ).toEqual({ ok: false, reason: 'missing-current-ratio' })
  })

  test('honours a locked completion ratio and rejects conflicts', () => {
    const locked = { ...snapshot, lockedCompletionRatio: 4 }
    const ok = buildRatioSyncRequest(
      makeRow(),
      { saleInput: '5', saleOutput: '20' },
      locked
    )
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.request.completion_ratio).toBe(4)
    const conflict = buildRatioSyncRequest(
      makeRow(),
      { saleInput: '5', saleOutput: '30' },
      locked
    )
    expect(conflict).toEqual({
      ok: false,
      reason: 'locked-completion-conflict',
      detail: '4',
    })
  })
})

describe('fillDetectedCosts', () => {
  const detected = {
    input: 1,
    output: 4,
    cacheRead: 0.1,
    cacheWrite: 0,
    via: 'detected' as const,
  }
  const missingWithDetected = makeRow({
    key: 'a|1',
    channelId: 1,
    costInput: null,
    costOutput: null,
    margin: null,
    detected,
  })
  const missingNoDetected = makeRow({
    key: 'b|2',
    channelId: 2,
    costInput: null,
    costOutput: null,
    margin: null,
  })
  const knownCost = makeRow({ key: 'c|3', channelId: 3 })

  test('stages detected prices and counts rows needing manual entry', () => {
    const result = fillDetectedCosts(
      [missingWithDetected, missingNoDetected, knownCost],
      {}
    )
    expect(result.filled).toBe(1)
    expect(result.manualOnly).toBe(1)
    expect(result.changes['a|1'].cost).toEqual(detected)
    expect(result.changes['b|2']).toBeUndefined()
    expect(result.changes['c|3']).toBeUndefined()
  })

  test('does not overwrite a cost staged by hand', () => {
    const manual = {
      cost: {
        input: 9,
        output: 9,
        cacheRead: 0,
        cacheWrite: 0,
        via: 'manual' as const,
      },
    }
    const result = fillDetectedCosts([missingWithDetected], { 'a|1': manual })
    expect(result.filled).toBe(0)
    expect(result.changes).toEqual({})
  })
})

describe('mergeModelPriceIntoSettings', () => {
  const cost = {
    input: 2,
    output: 8,
    cacheRead: 0.2,
    cacheWrite: 0,
    via: 'manual' as const,
  }

  test('adds the model price while preserving other settings and models', () => {
    const merged = JSON.parse(
      mergeModelPriceIntoSettings(
        JSON.stringify({
          upstream_group: 'bailian',
          model_prices: { 'other-model': { input: 1, output: 2 } },
        }),
        'test-model',
        cost
      )
    )
    expect(merged.upstream_group).toBe('bailian')
    expect(merged.model_prices['other-model']).toEqual({
      input: 1,
      output: 2,
    })
    expect(merged.model_prices['test-model']).toEqual({
      input: 2,
      output: 8,
      cache_read: 0.2,
      cache_write: 0,
      source: 'manual',
    })
  })

  test('tolerates empty and broken settings JSON', () => {
    const fromEmpty = JSON.parse(mergeModelPriceIntoSettings('', 'm', cost))
    expect(fromEmpty.model_prices.m.input).toBe(2)
    const fromBroken = JSON.parse(
      mergeModelPriceIntoSettings('{oops', 'm', cost)
    )
    expect(fromBroken.model_prices.m.input).toBe(2)
  })
})

describe('effectiveCost', () => {
  test('staged cost wins over the resolved basis', () => {
    const row = makeRow()
    expect(
      effectiveCost(row, {
        cost: {
          input: 9,
          output: 9,
          cacheRead: 0,
          cacheWrite: 0,
          via: 'manual',
        },
      })
    ).toEqual({ input: 9, output: 9 })
    expect(effectiveCost(row, undefined)).toEqual({ input: 2, output: 8 })
  })
})
