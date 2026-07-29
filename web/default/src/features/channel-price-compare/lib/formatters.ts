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
import type {
  ChannelSummary,
  OperationsSummary,
  PriceCompareModel,
} from '../types'

const PLACEHOLDER = '—'

export type ChannelSummarySort =
  | 'risk'
  | 'today_revenue'
  | 'today_cost'
  | 'today_profit'
  | 'today_margin'
  | 'today_requests'
  | 'total_revenue'
  | 'total_cost'
  | 'total_profit'

export type SortDirection = 'asc' | 'desc'

export type ChannelRiskFilter = 'all' | 'risk' | 'normal'

export function filterPriceCompareModels(
  models: PriceCompareModel[],
  modelFilter: string,
  channelFilter: string,
  riskFilter: ChannelRiskFilter
): PriceCompareModel[] {
  const modelKeyword = modelFilter.trim().toLocaleLowerCase()
  const channelKeyword = channelFilter.trim().toLocaleLowerCase()
  return models
    .filter(
      (model) =>
        !modelKeyword ||
        model.model_name.toLocaleLowerCase().includes(modelKeyword)
    )
    .map((model) => ({
      ...model,
      channels: model.channels.filter((channel) => {
        if (
          channelKeyword &&
          !channel.channel_name.toLocaleLowerCase().includes(channelKeyword)
        ) {
          return false
        }
        const hasRisk = channel.recommendations.length > 0
        if (riskFilter === 'risk') return hasRisk
        if (riskFilter === 'normal') return !hasRisk
        return true
      }),
    }))
    .filter((model) => model.channels.length > 0)
}

function sumBusinessMetrics(
  left: ChannelSummary['today'],
  right: ChannelSummary['today']
): ChannelSummary['today'] {
  const revenue = left.revenue + right.revenue
  const costAvailable = left.cost_available && right.cost_available
  const upstreamCost = left.upstream_cost + right.upstream_cost
  const profit = left.profit + right.profit
  return {
    requests: left.requests + right.requests,
    revenue,
    upstream_cost: upstreamCost,
    profit,
    margin: costAvailable && revenue > 0 ? (profit / revenue) * 100 : 0,
    cost_available: costAvailable,
  }
}

function emptyBusinessMetrics(): ChannelSummary['today'] {
  return {
    requests: 0,
    revenue: 0,
    upstream_cost: 0,
    profit: 0,
    margin: 0,
    cost_available: true,
  }
}

export function summarizePriceCompareModels(
  models: PriceCompareModel[]
): ChannelSummary[] {
  const summaries = new Map<number, ChannelSummary>()
  for (const model of models) {
    for (const channel of model.channels) {
      const current = summaries.get(channel.channel_id) ?? {
        channel_id: channel.channel_id,
        channel_name: channel.channel_name,
        model_count: 0,
        risk_count: 0,
        today: emptyBusinessMetrics(),
        total: emptyBusinessMetrics(),
      }
      summaries.set(channel.channel_id, {
        ...current,
        model_count: current.model_count + 1,
        risk_count:
          current.risk_count + (channel.recommendations.length > 0 ? 1 : 0),
        today: sumBusinessMetrics(current.today, channel.today),
        total: sumBusinessMetrics(current.total, channel.total),
      })
    }
  }
  return [...summaries.values()]
}

export function summarizeChannelRows(
  rows: ChannelSummary[]
): OperationsSummary {
  return rows.reduce<OperationsSummary>(
    (summary, row) => ({
      today: sumBusinessMetrics(summary.today, row.today),
      total: sumBusinessMetrics(summary.total, row.total),
      risk_channels: summary.risk_channels + (row.risk_count > 0 ? 1 : 0),
    }),
    {
      today: emptyBusinessMetrics(),
      total: emptyBusinessMetrics(),
      risk_channels: 0,
    }
  )
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return PLACEHOLDER
  const digits = Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 4 : 2
  return `$${value.toFixed(digits)}`
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return PLACEHOLDER
  return `${value.toFixed(1)}%`
}

function channelSummaryMetric(
  row: ChannelSummary,
  sort: ChannelSummarySort
): number | undefined {
  switch (sort) {
    case 'risk':
      return row.risk_count
    case 'today_revenue':
      return row.today.revenue
    case 'today_cost':
      return row.today.cost_available ? row.today.upstream_cost : undefined
    case 'today_profit':
      return row.today.cost_available ? row.today.profit : undefined
    case 'today_margin':
      return row.today.cost_available ? row.today.margin : undefined
    case 'today_requests':
      return row.today.requests
    case 'total_revenue':
      return row.total.revenue
    case 'total_cost':
      return row.total.cost_available ? row.total.upstream_cost : undefined
    case 'total_profit':
      return row.total.cost_available ? row.total.profit : undefined
  }
}

export function sortChannelSummaries(
  rows: ChannelSummary[],
  sort: ChannelSummarySort = 'risk',
  direction: SortDirection = 'desc'
): ChannelSummary[] {
  return [...rows].sort((left, right) => {
    const leftMetric = channelSummaryMetric(left, sort)
    const rightMetric = channelSummaryMetric(right, sort)
    if (leftMetric === undefined && rightMetric !== undefined) return 1
    if (leftMetric !== undefined && rightMetric === undefined) return -1
    if (leftMetric !== undefined && rightMetric !== undefined) {
      const difference = leftMetric - rightMetric
      if (difference !== 0) {
        return direction === 'asc' ? difference : -difference
      }
    }
    if (
      sort === 'risk' &&
      left.today.upstream_cost !== right.today.upstream_cost
    ) {
      return right.today.upstream_cost - left.today.upstream_cost
    }
    return left.channel_name.localeCompare(right.channel_name)
  })
}
