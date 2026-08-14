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

    assert.equal(result.kind, 'overflow')
  })

  test('rejects a positive source coefficient that formats to zero', () => {
    const result = computeOfficialSyncPlanResult(officialModel(1e-10), 0, 0.5)

    assert.equal(result.kind, 'overflow')
  })

  test('keeps the smallest represented positive coefficient and ordinary pricing', () => {
    const tiny = computeOfficialSyncPlanResult(officialModel(1e-9), 0, 0.5)
    const ordinary = computeOfficialSyncPlanResult(officialModel(1), 30, 1)

    assert.equal(tiny.kind, 'ready')
    assert.equal(ordinary.kind, 'ready')
    if (tiny.kind === 'ready') {
      assert.equal(tiny.plan.billingMode, 'tiered_expr')
      if (tiny.plan.billingMode === 'tiered_expr') {
        assert.match(tiny.plan.billingExpression, /p \* 1e-9(?:\D|$)/)
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

    assert.equal(result.kind, 'ready')
    if (result.kind === 'ready') {
      assert.equal(result.plan.billingMode, 'tiered_expr')
      if (result.plan.billingMode === 'tiered_expr') {
        assert.equal(result.plan.tiers[0].sellOutput, 8)
        assert.match(result.plan.billingExpression, /c \* 4(?:\D|$)/)
        assert.match(result.plan.billingExpression, /ao \* 8(?:\D|$)/)
      }
    }
  })
})
