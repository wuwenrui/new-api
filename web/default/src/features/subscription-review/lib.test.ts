import { describe, expect, test } from 'vitest'
import {
  buildManualOrderQueryParams,
  findOrderIndexByTradeNo,
  normalizeManualOrderSummary,
} from './lib'
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
    expect(findOrderIndexByTradeNo(list, 'SUB-002')).toBe(1)
  })

  test('returns -1 when the order is absent', () => {
    expect(findOrderIndexByTradeNo(list, 'SUB-999')).toBe(-1)
  })

  test('returns -1 for empty lookup values', () => {
    expect(findOrderIndexByTradeNo(list, '')).toBe(-1)
    expect(findOrderIndexByTradeNo(list, undefined)).toBe(-1)
    expect(findOrderIndexByTradeNo(list, null)).toBe(-1)
  })
})

describe('buildManualOrderQueryParams', () => {
  test('builds stable query params for subscription history requests', () => {
    expect(
      buildManualOrderQueryParams({
        page: 3,
        pageSize: 25,
        keyword: '高级',
        status: 'pending',
        startTimestamp: 100,
        endTimestamp: 900,
      })
    ).toBe(
      'p=3&page_size=25&keyword=%E9%AB%98%E7%BA%A7&status=pending&start_timestamp=100&end_timestamp=900'
    )
  })

  test('omits blank optional filters', () => {
    expect(
      buildManualOrderQueryParams({
        page: 1,
        pageSize: 100,
        keyword: '',
        status: '',
        startTimestamp: 0,
        endTimestamp: 0,
      })
    ).toBe('p=1&page_size=100')
  })
})

describe('normalizeManualOrderSummary', () => {
  test('fills missing subscription summary fields with zero values', () => {
    expect(normalizeManualOrderSummary(undefined)).toEqual({
      total_count: 0,
      pending_count: 0,
      success_count: 0,
      failed_count: 0,
      expired_count: 0,
      total_money: 0,
      pending_money: 0,
      success_money: 0,
      failed_money: 0,
      expired_money: 0,
      by_status: [],
      by_method: [],
    })
  })
})
