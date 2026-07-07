import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  formatGiftedEstimate,
  formatPACMonitorStatus,
  sumFinanceReportRows,
} from './lib'

const financeReportSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'index.tsx'),
  'utf8'
)
const sidebarSource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../hooks/use-sidebar-data.ts'
  ),
  'utf8'
)

describe('finance report copy', () => {
  test('uses Chinese-facing labels for finance report text', () => {
    const englishLabels = [
      'Finance Report',
      'Consumption Revenue',
      'Estimated Upstream Cost',
      'Gross Profit',
      'Cash Income',
      'Stripped by group ratio',
      'Model Profit Ranking',
      'User Contribution Ranking',
      'Requests',
      'Revenue',
      'Cost',
      'Profit',
      'Margin',
      'User',
    ]

    for (const label of englishLabels) {
      assert.equal(financeReportSource.includes(`t('${label}')`), false)
    }

    assert.equal(sidebarSource.includes("t('Finance Report')"), false)
  })
})

describe('formatGiftedEstimate', () => {
  test('clamps negative estimate to zero', () => {
    assert.equal(
      formatGiftedEstimate(-97, { symbol: '¥', rate: 1, type: 'CNY' }),
      '¥0.00'
    )
  })

  test('formats positive estimate with two decimals', () => {
    assert.equal(
      formatGiftedEstimate(12.345, { symbol: '¥', rate: 1, type: 'CNY' }),
      '¥12.35'
    )
  })
})

describe('formatPACMonitorStatus', () => {
  test('formats monitor statuses for admin table', () => {
    assert.equal(formatPACMonitorStatus('healthy'), '正常')
    assert.equal(formatPACMonitorStatus('risk'), '低毛利')
    assert.equal(formatPACMonitorStatus('changed'), '价格变更')
    assert.equal(formatPACMonitorStatus('unknown'), '未知')
  })
})

describe('sumFinanceReportRows', () => {
  test('adds PAC monitor interval totals', () => {
    assert.deepEqual(
      sumFinanceReportRows([
        {
          revenue: 12,
          estimated_upstream_cost: 4,
          gross_profit: 8,
        },
        {
          revenue: 8,
          estimated_upstream_cost: 2,
          gross_profit: 6,
        },
      ]),
      {
        requests: 0,
        usage_amount: 20,
        estimated_upstream_cost: 6,
        gross_profit: 14,
        gross_margin: 70,
        balance: 0,
        total_topup: 0,
      }
    )
  })

  test('adds model ranking totals and recomputes margin from totals', () => {
    const totals = sumFinanceReportRows([
      {
        requests: 2,
        consumption_amount: 10,
        estimated_upstream_cost: 4,
        gross_profit: 6,
        gross_margin: 60,
      },
      {
        requests: 3,
        consumption_amount: 30,
        estimated_upstream_cost: 10,
        gross_profit: 20,
        gross_margin: 66.67,
      },
    ])

    assert.equal(totals.requests, 5)
    assert.equal(totals.usage_amount, 40)
    assert.equal(totals.estimated_upstream_cost, 14)
    assert.equal(totals.gross_profit, 26)
    assert.equal(totals.gross_margin, 65)
  })

  test('adds user contribution totals', () => {
    const totals = sumFinanceReportRows([
      {
        requests: 4,
        balance: 7,
        total_topup: 20,
        consumption_amount: 18,
        gross_profit: 9,
      },
      {
        requests: 6,
        balance: 3,
        total_topup: 10,
        consumption_amount: 12,
        gross_profit: 6,
      },
    ])

    assert.equal(totals.requests, 10)
    assert.equal(totals.balance, 10)
    assert.equal(totals.total_topup, 30)
    assert.equal(totals.usage_amount, 30)
    assert.equal(totals.gross_profit, 15)
    assert.equal(totals.gross_margin, 50)
  })
})
