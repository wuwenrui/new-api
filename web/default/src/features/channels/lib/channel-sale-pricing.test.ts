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
import { describe, expect, it } from 'vitest'

import type { SystemOption } from '../../system-settings/types'
import {
  buildSaleRequest,
  grossMargin,
  parsePurchase,
  readSaleSnapshot,
  saleFromMargin,
  snapshotSignature,
} from './channel-sale-pricing'

function options(values: Record<string, unknown>): SystemOption[] {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }))
}
const costs = { input: 2.5, output: 12.5, cache_read: 0.25, cache_write: 3.125 }
const base = {
  GroupRatio: { default: 2 },
  CompletionRatioMeta: { m: { ratio: 5, locked: false } },
}

describe('channel selling prices', () => {
  it('detects missing prices without treating explicitly free models as missing', () => {
    expect(readSaleSnapshot('m', options(base)).status).toBe('missing')
    const free = readSaleSnapshot(
      'm',
      options({ ...base, ModelRatio: { m: 0 } })
    )
    expect(free.status).toBe('ratio')
    expect(free.prices).toEqual({
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    })
  })
  it('recognizes fixed and tiered models before legacy ratios', () => {
    expect(
      readSaleSnapshot('m', options({ ...base, ModelPrice: { m: 0 } })).status
    ).toBe('fixed')
    expect(
      readSaleSnapshot(
        'm',
        options({
          ...base,
          ModelPrice: { m: 1 },
          'billing_setting.billing_mode': { m: 'tiered_expr' },
          'billing_setting.billing_expr': { m: 'tier("standard", p * 5)' },
        })
      ).status
    ).toBe('tiered')
  })
  it('resolves canonical pricing names and effective completion metadata', () => {
    const snapshot = readSaleSnapshot(
      'm-suffix',
      options({
        ...base,
        PricingModelKey: 'm',
        ModelRatio: { m: 1 },
        CompletionRatio: { m: 8 },
        CacheRatio: { m: 0.7, 'm-suffix': 0.1 },
        CreateCacheRatio: { m: 2, 'm-suffix': 1.25 },
      })
    )
    expect(snapshot.key).toBe('m')
    expect(snapshot.prices).toEqual({
      input: 2,
      output: 10,
      cache_read: 0.2,
      cache_write: 2.5,
    })
  })
  it('calculates gross margin rather than markup and preserves zero costs', () => {
    expect(saleFromMargin(costs, 20)).toEqual({
      input: 3.125,
      output: 15.625,
      cache_read: 0.3125,
      cache_write: 3.90625,
    })
    expect(grossMargin(3.125, 2.5)).toBeCloseTo(20)
    expect(grossMargin(0, 0)).toBeNull()
    expect(saleFromMargin({ ...costs, cache_read: 0 }, 20)?.cache_read).toBe(0)
  })
  it('refuses missing, negative, nonfinite costs and impossible margins', () => {
    expect(parsePurchase({ input: 2 })).toBeNull()
    expect(parsePurchase({ ...costs, output: Infinity })).toBeNull()
    expect(parsePurchase({ ...costs, output: -1 })).toBeNull()
    for (const margin of [-1, 100, 101, Number.NaN, Infinity]) {
      expect(saleFromMargin(costs, margin)).toBeNull()
    }
  })
  it('converts group-adjusted USD proposals without rounding the ratios', () => {
    const snapshot = readSaleSnapshot('m', options(base))
    const proposal = saleFromMargin(costs, 20)
    if (!proposal) throw new Error('Expected a valid margin proposal')
    expect(buildSaleRequest(snapshot, proposal, 2)).toEqual({
      model_name: 'm',
      billing_mode: 'ratio',
      model_ratio: 0.78125,
      completion_ratio: 5,
      cache_ratio: 0.1,
      create_cache_ratio: 1.25,
    })
    expect(() => buildSaleRequest(snapshot, costs, 0)).toThrow()
    expect(() =>
      buildSaleRequest(snapshot, { ...costs, input: 0 }, 2)
    ).toThrow()
  })
  it('omits locked completion ratio and rejects conflicting proposals', () => {
    const snapshot = readSaleSnapshot(
      'm',
      options({
        ...base,
        CompletionRatioMeta: { m: { ratio: 5, locked: true } },
      })
    )
    expect(buildSaleRequest(snapshot, costs, 2)).not.toHaveProperty(
      'completion_ratio'
    )
    expect(() =>
      buildSaleRequest(snapshot, { ...costs, output: 10 }, 2)
    ).toThrow()
  })
  it('never converts existing fixed or tiered rules to flat token pricing', () => {
    const snapshot = readSaleSnapshot(
      'm',
      options({ ...base, ModelPrice: { m: 3 } })
    )
    expect(() => buildSaleRequest(snapshot, costs, 2)).toThrow()
  })
  it('fingerprints only this model and the selected group but includes billing transitions', () => {
    const a = readSaleSnapshot('m', options(base))
    const b = readSaleSnapshot(
      'm',
      options({ ...base, ModelRatio: { other: 3 } })
    )
    expect(snapshotSignature(a, 'default')).toBe(
      snapshotSignature(b, 'default')
    )
    const c = readSaleSnapshot(
      'm',
      options({ ...base, GroupRatio: { default: 3 } })
    )
    expect(snapshotSignature(a, 'default')).not.toBe(
      snapshotSignature(c, 'default')
    )
  })
  it('rejects ratio conversion that underflows the positive input price', () => {
    const snapshot = readSaleSnapshot('m', options(base))
    expect(() =>
      buildSaleRequest(
        snapshot,
        { input: Number.MIN_VALUE, output: 0, cache_read: 0, cache_write: 0 },
        2
      )
    ).toThrow()
  })
})
