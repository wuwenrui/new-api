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

import type { PriceCompareChannel } from '../types'
import {
  computeSyncRatios,
  resolveSyncBasis,
  shouldUseOfficialPricing,
} from './price-sync'

const baseChannel: PriceCompareChannel = {
  channel_id: 1,
  channel_name: 'basis-validation',
  upstream_group: 'default',
  upstream_model: 'model',
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
  local_input: 2,
  local_output: 8,
  local_cache_read: 0,
  local_cache_write: 0,
  upstream_input: 2,
  upstream_output: 8,
  upstream_cache_read: 0.2,
  upstream_cache_write: 2,
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
}

function channel(overrides: Partial<PriceCompareChannel>): PriceCompareChannel {
  return { ...baseChannel, ...overrides }
}

describe('resolveSyncBasis validation', () => {
  test('rejects a zero manual input cost before planning', () => {
    const result = resolveSyncBasis(
      channel({
        price_source: 'manual',
        detected_available: false,
        upstream_input: 0,
      })
    )

    expect(result).toBeNull()
  })

  test('rejects a zero detected input cost before planning', () => {
    const result = resolveSyncBasis(channel({ detected_input: 0 }))

    expect(result).toBeNull()
  })

  test('does not fall back to official pricing for invalid manual pricing', () => {
    const manual = channel({
      price_source: 'manual',
      detected_available: false,
      uses_official_pricing: true,
    })

    expect(shouldUseOfficialPricing(manual, null)).toBe(false)
  })

  test('falls back to official pricing when detected pricing is invalid', () => {
    const detected = channel({
      detected_input: 0,
      uses_official_pricing: true,
    })
    const result = resolveSyncBasis(detected)

    expect(result).toBeNull()
    expect(shouldUseOfficialPricing(detected, result)).toBe(true)
  })

  test('uses valid detected pricing before a persisted official source', () => {
    const persistedOfficial = channel({
      price_source: 'models_dev',
      detected_available: true,
      uses_official_pricing: true,
    })
    const result = resolveSyncBasis(persistedOfficial)

    expect(result?.source).toBe('detected')
    expect(result?.input).toBe(2)
    expect(shouldUseOfficialPricing(persistedOfficial, result)).toBe(false)
  })

  test('rejects non-finite or negative output and cache costs', () => {
    expect(resolveSyncBasis(channel({ detected_output: -1 }))).toBeNull()
    expect(
      resolveSyncBasis(channel({ detected_cache_read: Number.NaN }))
    ).toBeNull()
    expect(
      resolveSyncBasis(
        channel({ detected_cache_write: Number.POSITIVE_INFINITY })
      )
    ).toBeNull()
  })

  test('allows free output and cache costs', () => {
    const result = resolveSyncBasis(
      channel({
        detected_output: 0,
        detected_cache_read: 0,
        detected_cache_write: 0,
      })
    )

    expect(result).toBeTruthy()
    if (!result) {
      throw new Error('expected a sync basis for free output and cache costs')
    }
    expect(computeSyncRatios(result, 30, 1)).toBeTruthy()
  })
})
