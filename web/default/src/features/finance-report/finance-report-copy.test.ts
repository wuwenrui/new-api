import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { formatGiftedEstimate, formatPACMonitorStatus } from './lib'

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
