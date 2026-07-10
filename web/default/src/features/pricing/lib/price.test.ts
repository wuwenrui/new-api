import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { PricingModel } from '../types'
import {
  formatDisplayDiscountLabel,
  formatGroupDiscountLabel,
  formatPrice,
} from './price'

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
  test('formats the user-visible discount with the displayed group ratio', () => {
    const model = tokenModel({
      model_ratio: 5,
      completion_ratio: 5,
      group_ratio: { default: 2.5 },
    })

    assert.equal(formatPrice(model, 'input', 'M', false, 1, 1, 'default'), '$25')
    assert.equal(formatPrice(model, 'output', 'M', false, 1, 1, 'default'), '$125')
    assert.equal(
      formatDisplayDiscountLabel(model, 'default', {
        showRechargePrice: false,
        priceRate: 1,
        usdExchangeRate: 1,
      }),
      '3.6折'
    )
  })

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

  test('formats configured model discounts for the default group', () => {
    const cases = [
      { modelRatio: 2.5, completionRatio: 5, input: 35, output: 175, expected: '3.6折' },
      { modelRatio: 1.5, completionRatio: 5, input: 21, output: 105, expected: '3.6折' },
      { modelRatio: 1, completionRatio: 5, input: 14, output: 70, expected: '3.6折' },
      { modelRatio: 0.4, completionRatio: 3, input: 14, output: 42, expected: '1.4折' },
    ]

    for (const item of cases) {
      assert.equal(
        formatDisplayDiscountLabel(
          tokenModel({
            model_ratio: item.modelRatio,
            completion_ratio: item.completionRatio,
            group_ratio: { default: 2.5 },
            original_price: { input: item.input, output: item.output },
          }),
          'default',
          {
            showRechargePrice: false,
            priceRate: 1,
            usdExchangeRate: 1,
          }
        ),
        item.expected
      )
    }
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
    assert.equal(
      formatDisplayDiscountLabel(
        tokenModel({ original_price: undefined }),
        'default',
        {
          showRechargePrice: false,
          priceRate: 1,
          usdExchangeRate: 1,
        }
      ),
      null
    )
  })
})
