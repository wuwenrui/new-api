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
import { computeOfficialSyncPlanResult } from './price-sync'

function officialModel(input: number): NewAPIProbeModel {
  return {
    model_name: 'representability-model',
    vendor_id: 1,
    quota_type: 0,
    model_ratio: 1,
    model_price: 0,
    completion_ratio: 0,
    cache_ratio: 0,
    create_cache_ratio: 0,
    image_ratio: 0,
    audio_ratio: 0,
    audio_completion_ratio: 0,
    enable_groups: ['default'],
    supported_endpoint_types: ['openai'],
    models_dev_pricing: {
      base: { input, output: 0 },
      tiers: [],
      upstream_multiplier: 1,
    },
  }
}

describe('official billing expression representability', () => {
  test('rejects a group ratio whose billing divisor overflows', () => {
    const result = computeOfficialSyncPlanResult(
      officialModel(1),
      0,
      Number.MAX_VALUE
    )

    expect(result.kind).toBe('overflow')
  })

  test('rejects a positive source coefficient that formats to zero', () => {
    const result = computeOfficialSyncPlanResult(officialModel(1e-10), 0, 0.5)

    expect(result.kind).toBe('overflow')
  })

  test('keeps the smallest represented positive coefficient and ordinary pricing', () => {
    const tiny = computeOfficialSyncPlanResult(officialModel(1e-9), 0, 0.5)
    const ordinary = computeOfficialSyncPlanResult(officialModel(1), 30, 1)

    expect(tiny.kind).toBe('ready')
    expect(ordinary.kind).toBe('ready')
    if (tiny.kind === 'ready') {
      expect(tiny.plan.billingMode).toBe('tiered_expr')
      if (tiny.plan.billingMode === 'tiered_expr') {
        expect(tiny.plan.billingExpression).toMatch(/p \* 1e-9(?:\D|$)/)
      }
    }
  })

  test('applies markup to paid tier output when base output is free', () => {
    const model = officialModel(1)
    const pricing = model.models_dev_pricing
    assert.ok(pricing)
    const result = computeOfficialSyncPlanResult(
      {
        ...model,
        models_dev_pricing: {
          ...pricing,
          tiers: [
            {
              context_threshold: 100,
              input: 2,
              output: 4,
              output_audio: 8,
            },
          ],
        },
      },
      100,
      1
    )

    expect(result.kind).toBe('ready')
    if (result.kind === 'ready') {
      expect(result.plan.billingMode).toBe('tiered_expr')
      if (result.plan.billingMode === 'tiered_expr') {
        expect(result.plan.tiers[0].sellOutput).toBe(8)
        expect(result.plan.billingExpression).toMatch(/c \* 4(?:\D|$)/)
        expect(result.plan.billingExpression).toMatch(/ao \* 8(?:\D|$)/)
      }
    }
  })
})
