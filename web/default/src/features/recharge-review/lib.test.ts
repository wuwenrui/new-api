import { describe, expect, test } from 'vitest'
import {
  buildManualOrderQueryParams,
  buildManualStatusPayload,
  buildCompletePayload,
  findOrderIndexByTradeNo,
  normalizeManualOrderSummary,
  previewQuota,
} from './lib'
import type { PendingManualTopUp } from './types'

function makeOrder(
  overrides: Partial<PendingManualTopUp> = {}
): PendingManualTopUp {
  return {
    id: 1,
    user_id: 7,
    username: 'alice',
    email: 'alice@example.com',
    amount: 50,
    money: 50,
    payment_method: 'wxpay',
    create_time: 1_700_000_000,
    trade_no: 'TN-001',
    status: 'pending',
    ...overrides,
  }
}

describe('buildCompletePayload', () => {
  test('keeps trade_no and integer amount', () => {
    expect(buildCompletePayload('TN-001', 50)).toEqual({
      trade_no: 'TN-001',
      amount: 50,
    })
  })

  test('truncates fractional amounts to integers', () => {
    expect(buildCompletePayload('TN-002', 12.9)).toEqual({
      trade_no: 'TN-002',
      amount: 12,
    })
  })

  test('normalizes non-finite amounts to zero', () => {
    expect(buildCompletePayload('TN-003', Number.NaN).amount).toBe(0)
    expect(buildCompletePayload('TN-004', Number.POSITIVE_INFINITY).amount).toBe(0)
  })
})

describe('findOrderIndexByTradeNo', () => {
  const list = [
    makeOrder({ id: 1, trade_no: 'TN-001' }),
    makeOrder({ id: 2, trade_no: 'TN-002' }),
    makeOrder({ id: 3, trade_no: 'TN-003' }),
  ]

  test('returns the index of the matching order', () => {
    expect(findOrderIndexByTradeNo(list, 'TN-002')).toBe(1)
  })

  test('returns -1 when not found', () => {
    expect(findOrderIndexByTradeNo(list, 'TN-999')).toBe(-1)
  })

  test('returns -1 for empty or missing lookup values', () => {
    expect(findOrderIndexByTradeNo(list, '')).toBe(-1)
    expect(findOrderIndexByTradeNo(list, undefined)).toBe(-1)
    expect(findOrderIndexByTradeNo(list, null)).toBe(-1)
  })

  test('returns -1 for an empty list', () => {
    expect(findOrderIndexByTradeNo([], 'TN-001')).toBe(-1)
  })
})

describe('previewQuota', () => {
  test('renders a positive integer amount', () => {
    expect(previewQuota(50)).toBe('50')
  })

  test('prefixes an optional currency symbol', () => {
    expect(previewQuota(50, '$')).toBe('$50')
  })

  test('truncates fractional amounts', () => {
    expect(previewQuota(12.9)).toBe('12')
  })

  test('renders zero placeholder for non-positive or invalid amounts', () => {
    expect(previewQuota(0)).toBe('0')
    expect(previewQuota(-5)).toBe('0')
    expect(previewQuota(Number.NaN, '$')).toBe('$0')
  })
})

describe('buildManualOrderQueryParams', () => {
  test('builds stable query params for history requests', () => {
    expect(
      buildManualOrderQueryParams({
        page: 2,
        pageSize: 50,
        keyword: ' bob ',
        status: 'success',
        startTimestamp: 1000,
        endTimestamp: 2000,
      })
    ).toBe(
      'p=2&page_size=50&keyword=bob&status=success&start_timestamp=1000&end_timestamp=2000'
    )
  })

  test('omits empty filters and all status', () => {
    expect(
      buildManualOrderQueryParams({
        page: 1,
        pageSize: 20,
        keyword: ' ',
        status: 'all',
        startTimestamp: 0,
        endTimestamp: 0,
      })
    ).toBe('p=1&page_size=20')
  })
})

describe('buildManualStatusPayload', () => {
  test('keeps trade numbers and defaults all to false', () => {
    expect(buildManualStatusPayload(['TN-001'])).toEqual({
      trade_nos: ['TN-001'],
      all: false,
    })
  })

  test('supports all orders', () => {
    expect(buildManualStatusPayload(undefined, true)).toEqual({
      trade_nos: [],
      all: true,
    })
  })
})

describe('normalizeManualOrderSummary', () => {
  test('fills missing summary fields with zero values', () => {
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
