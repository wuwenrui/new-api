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

import type {
  ChannelSummary,
  PriceCompareChannel,
  PriceCompareModel,
} from '../types'
import {
  filterPriceCompareModels,
  formatPercent,
  formatUsd,
  sortChannelSummaries,
  summarizePriceCompareModels,
  summarizeChannelRows,
} from './formatters'

const summary = (
  channel_id: number,
  risk_count: number,
  upstream_cost: number
): ChannelSummary => ({
  channel_id,
  channel_name: `channel-${channel_id}`,
  model_count: 1,
  risk_count,
  today: {
    requests: 1,
    revenue: 10,
    upstream_cost,
    profit: 10 - upstream_cost,
    margin: 50,
    cost_available: true,
  },
  total: {
    requests: 1,
    revenue: 10,
    upstream_cost,
    profit: 10 - upstream_cost,
    margin: 50,
    cost_available: true,
  },
})

const priceModel = (
  name: string,
  channels: [number, string, boolean][]
): PriceCompareModel => ({
  model_name: name,
  channels: channels.map(
    ([channel_id, channel_name, risk]) =>
      ({
        channel_id,
        channel_name,
        recommendations: risk ? ['low_success_rate'] : [],
        today: {
          requests: channel_id,
          revenue: channel_id * 10,
          upstream_cost: channel_id * 4,
          profit: channel_id * 6,
          margin: 60,
          cost_available: true,
        },
        total: {
          requests: channel_id * 2,
          revenue: channel_id * 20,
          upstream_cost: channel_id * 8,
          profit: channel_id * 12,
          margin: 60,
          cost_available: true,
        },
      }) as PriceCompareChannel
  ),
})

describe('channel operations formatters', () => {
  test('formats USD and percentages without hiding small values', () => {
    assert.equal(formatUsd(0.0042), '$0.0042')
    assert.equal(formatUsd(12.3456), '$12.35')
    assert.equal(formatPercent(-12.34), '-12.3%')
  })

  test('sorts risky channels first and then by today cost', () => {
    const rows = [summary(1, 0, 9), summary(2, 2, 2), summary(3, 2, 8)]
    assert.deepEqual(
      sortChannelSummaries(rows).map((row) => row.channel_id),
      [3, 2, 1]
    )
    assert.deepEqual(
      rows.map((row) => row.channel_id),
      [1, 2, 3]
    )
  })

  test('sorts channel metrics in either direction without mutating input', () => {
    const rows = [summary(1, 0, 9), summary(2, 0, 2), summary(3, 0, 8)]
    rows[0].today.revenue = 3
    rows[1].today.revenue = 12
    rows[2].today.revenue = 7
    rows[0].today.requests = 30
    rows[1].today.requests = 10
    rows[2].today.requests = 20

    assert.deepEqual(
      sortChannelSummaries(rows, 'today_revenue', 'desc').map(
        (row) => row.channel_id
      ),
      [2, 3, 1]
    )
    assert.deepEqual(
      sortChannelSummaries(rows, 'today_requests', 'asc').map(
        (row) => row.channel_id
      ),
      [2, 3, 1]
    )
    assert.deepEqual(
      sortChannelSummaries(rows, 'total_profit', 'desc').map(
        (row) => row.channel_id
      ),
      [2, 3, 1]
    )
    assert.deepEqual(
      rows.map((row) => row.channel_id),
      [1, 2, 3]
    )
  })

  test('filters model routes by model, channel, and risk without mutating input', () => {
    const models = [
      priceModel('gpt-5', [
        [1, 'premium-a', true],
        [2, 'stable-b', false],
      ]),
      priceModel('claude-opus', [[3, 'premium-c', false]]),
    ]

    const result = filterPriceCompareModels(models, 'gpt', 'premium', 'risk')
    assert.deepEqual(
      result.map((model) => ({
        name: model.model_name,
        channels: model.channels.map((channel) => channel.channel_id),
      })),
      [{ name: 'gpt-5', channels: [1] }]
    )
    assert.equal(models[0].channels.length, 2)
    assert.deepEqual(
      filterPriceCompareModels(models, '', '', 'normal').map(
        (model) => model.model_name
      ),
      ['gpt-5', 'claude-opus']
    )
  })
  test('recomputes channel summaries from the visible model routes', () => {
    const models = [
      priceModel('gpt-5', [[1, 'shared', true]]),
      priceModel('claude-opus', [
        [1, 'shared', false],
        [2, 'other', false],
      ]),
    ]

    const allRows = summarizePriceCompareModels(models)
    const gptRows = summarizePriceCompareModels(
      filterPriceCompareModels(models, 'gpt', '', 'all')
    )

    assert.equal(allRows.find((row) => row.channel_id === 1)?.model_count, 2)
    assert.equal(allRows.find((row) => row.channel_id === 1)?.total.revenue, 40)
    assert.equal(gptRows.length, 1)
    assert.equal(gptRows[0].model_count, 1)
    assert.equal(gptRows[0].risk_count, 1)
    assert.equal(gptRows[0].total.revenue, 20)
    assert.equal(gptRows[0].total.profit, 12)
    const pageSummary = summarizeChannelRows(gptRows)
    assert.equal(pageSummary.today.revenue, 10)
    assert.equal(pageSummary.total.profit, 12)
    assert.equal(pageSummary.risk_channels, 1)
  })
})
