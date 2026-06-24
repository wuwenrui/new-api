import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { findOrderIndexByTradeNo } from './lib'
import type { PendingManualSubscription } from './types'

function makeOrder(
  overrides: Partial<PendingManualSubscription> = {}
): PendingManualSubscription {
  return {
    id: 1,
    user_id: 7,
    username: 'alice',
    email: 'alice@example.com',
    plan_id: 3,
    plan_title: 'WeChat Pro',
    money: 199,
    payment_method: 'manual_wechat',
    create_time: 1_700_000_000,
    trade_no: 'SUB-001',
    status: 'pending',
    ...overrides,
  }
}

describe('findOrderIndexByTradeNo', () => {
  const list = [
    makeOrder({ id: 1, trade_no: 'SUB-001' }),
    makeOrder({ id: 2, trade_no: 'SUB-002' }),
    makeOrder({ id: 3, trade_no: 'SUB-003' }),
  ]

  test('returns the matching subscription order index', () => {
    assert.equal(findOrderIndexByTradeNo(list, 'SUB-002'), 1)
  })

  test('returns -1 when the order is absent', () => {
    assert.equal(findOrderIndexByTradeNo(list, 'SUB-999'), -1)
  })

  test('returns -1 for empty lookup values', () => {
    assert.equal(findOrderIndexByTradeNo(list, ''), -1)
    assert.equal(findOrderIndexByTradeNo(list, undefined), -1)
    assert.equal(findOrderIndexByTradeNo(list, null), -1)
  })
})
