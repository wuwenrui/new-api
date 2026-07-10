import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
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
    assert.deepEqual(buildCompletePayload('TN-001', 50), {
      trade_no: 'TN-001',
      amount: 50,
    })
  })

  test('truncates fractional amounts to integers', () => {
    assert.deepEqual(buildCompletePayload('TN-002', 12.9), {
      trade_no: 'TN-002',
      amount: 12,
    })
  })

  test('normalizes non-finite amounts to zero', () => {
    assert.equal(buildCompletePayload('TN-003', Number.NaN).amount, 0)
    assert.equal(
      buildCompletePayload('TN-004', Number.POSITIVE_INFINITY).amount,
      0
    )
  })
})

describe('findOrderIndexByTradeNo', () => {
  const list = [
    makeOrder({ id: 1, trade_no: 'TN-001' }),
    makeOrder({ id: 2, trade_no: 'TN-002' }),
    makeOrder({ id: 3, trade_no: 'TN-003' }),
  ]

  test('returns the index of the matching order', () => {
    assert.equal(findOrderIndexByTradeNo(list, 'TN-002'), 1)
  })

  test('returns -1 when not found', () => {
    assert.equal(findOrderIndexByTradeNo(list, 'TN-999'), -1)
  })

  test('returns -1 for empty or missing lookup values', () => {
    assert.equal(findOrderIndexByTradeNo(list, ''), -1)
    assert.equal(findOrderIndexByTradeNo(list, undefined), -1)
    assert.equal(findOrderIndexByTradeNo(list, null), -1)
  })

  test('returns -1 for an empty list', () => {
    assert.equal(findOrderIndexByTradeNo([], 'TN-001'), -1)
  })
})

describe('previewQuota', () => {
  test('renders a positive integer amount', () => {
    assert.equal(previewQuota(50), '50')
  })

  test('prefixes an optional currency symbol', () => {
    assert.equal(previewQuota(50, '$'), '$50')
  })

  test('truncates fractional amounts', () => {
    assert.equal(previewQuota(12.9), '12')
  })

  test('renders zero placeholder for non-positive or invalid amounts', () => {
    assert.equal(previewQuota(0), '0')
    assert.equal(previewQuota(-5), '0')
    assert.equal(previewQuota(Number.NaN, '$'), '$0')
  })
})

describe('buildManualOrderQueryParams', () => {
  test('builds stable query params for history requests', () => {
    assert.equal(
      buildManualOrderQueryParams({
        page: 2,
        pageSize: 50,
        keyword: ' bob ',
        status: 'success',
        startTimestamp: 1000,
        endTimestamp: 2000,
      }),
      'p=2&page_size=50&keyword=bob&status=success&start_timestamp=1000&end_timestamp=2000'
    )
  })

  test('omits empty filters and all status', () => {
    assert.equal(
      buildManualOrderQueryParams({
        page: 1,
        pageSize: 20,
        keyword: ' ',
        status: 'all',
        startTimestamp: 0,
        endTimestamp: 0,
      }),
      'p=1&page_size=20'
    )
  })
})

describe('buildManualStatusPayload', () => {
  test('keeps trade numbers and defaults all to false', () => {
    assert.deepEqual(buildManualStatusPayload(['TN-001']), {
      trade_nos: ['TN-001'],
      all: false,
    })
  })

  test('supports all orders', () => {
    assert.deepEqual(buildManualStatusPayload(undefined, true), {
      trade_nos: [],
      all: true,
    })
  })
})

describe('normalizeManualOrderSummary', () => {
  test('fills missing summary fields with zero values', () => {
    assert.deepEqual(normalizeManualOrderSummary(undefined), {
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
