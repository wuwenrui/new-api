import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

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
      expect(financeReportSource.includes(`t('${label}')`)).toBe(false)
    }

    expect(sidebarSource.includes("t('Finance Report')")).toBe(false)
  })
})

describe('formatGiftedEstimate', () => {
  test('clamps negative estimate to zero', () => {
    expect(formatGiftedEstimate(-97, { symbol: '¥', rate: 1, type: 'CNY' })).toBe(
      '¥0.00'
    )
  })

  test('formats positive estimate with two decimals', () => {
    expect(
      formatGiftedEstimate(12.345, { symbol: '¥', rate: 1, type: 'CNY' })
    ).toBe('¥12.35')
  })
})

describe('formatPACMonitorStatus', () => {
  test('formats monitor statuses for admin table', () => {
    expect(formatPACMonitorStatus('healthy')).toBe('正常')
    expect(formatPACMonitorStatus('risk')).toBe('低毛利')
    expect(formatPACMonitorStatus('changed')).toBe('价格变更')
    expect(formatPACMonitorStatus('unknown')).toBe('未知')
  })
})

describe('sumFinanceReportRows', () => {
  test('adds PAC monitor interval totals', () => {
    expect(
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
      ])
    ).toEqual({
      requests: 0,
      usage_amount: 20,
      estimated_upstream_cost: 6,
      gross_profit: 14,
      gross_margin: 70,
      balance: 0,
      total_topup: 0,
    })
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

    expect(totals.requests).toBe(5)
    expect(totals.usage_amount).toBe(40)
    expect(totals.estimated_upstream_cost).toBe(14)
    expect(totals.gross_profit).toBe(26)
    expect(totals.gross_margin).toBe(65)
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

    expect(totals.requests).toBe(10)
    expect(totals.balance).toBe(10)
    expect(totals.total_topup).toBe(30)
    expect(totals.usage_amount).toBe(30)
    expect(totals.gross_profit).toBe(15)
    expect(totals.gross_margin).toBe(50)
  })
})
