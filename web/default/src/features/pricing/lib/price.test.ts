import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { PricingModel } from '../types'
import { formatGroupDiscountLabel } from './price'

function tokenModel(overrides: Partial<PricingModel> = {}): PricingModel {
  return {
    id: 1,
    model_name: 'claude-fable-5',
    quota_type: 0,
    model_ratio: 2.5,
    completion_ratio: 5,
    enable_groups: ['default'],
    original_price: { input: 70, output: 350 },
    ...overrides,
  }
}

describe('pricing discount labels', () => {
  test('formats configured original price as a discount label', () => {
    assert.equal(
      formatGroupDiscountLabel(tokenModel(), 'default', {
        groupRatio: { default: 1 },
        showRechargePrice: true,
        priceRate: 5,
        usdExchangeRate: 7,
      }),
      '3.6折'
    )
  })

  test('hides discount when original price is missing', () => {
    assert.equal(
      formatGroupDiscountLabel(
        tokenModel({ original_price: undefined }),
        'default',
        {
          groupRatio: { default: 1 },
          showRechargePrice: true,
          priceRate: 5,
          usdExchangeRate: 7,
        }
      ),
      null
    )
  })
})
