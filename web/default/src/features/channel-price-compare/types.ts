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
// ----------------------------------------------------------------------------
// Channel price comparison types
// Prices are expressed in USD per 1M tokens; margins are percentages.
// ----------------------------------------------------------------------------

export interface BusinessMetrics {
  requests: number
  revenue: number
  upstream_cost: number
  profit: number
  margin: number
  cost_available: boolean
}

export interface QualityMetrics {
  successes: number
  errors: number
  success_rate: number
  average_use_time: number
  last_error_at: number
  last_error_code: string
}

export type PriceCompareStatus = 'ok' | 'unknown'

export interface PriceCompareChannel {
  channel_id: number
  channel_name: string
  upstream_group: string
  upstream_model: string
  priority: number
  weight: number
  routing_role: 'primary' | 'primary_pool' | 'backup'
  status: PriceCompareStatus
  status_reason: string
  price_source: 'manual' | 'detected' | 'missing'
  price_changed: boolean
  detected_available: boolean
  uses_fixed_price: boolean
  fixed_price: number
  billing_mode: 'ratio' | 'tiered_expr'
  billing_expr?: string
  local_input: number
  local_output: number
  local_cache_read: number
  local_cache_write: number
  upstream_input: number
  upstream_output: number
  upstream_cache_read: number
  upstream_cache_write: number
  detected_input: number
  detected_output: number
  detected_cache_read: number
  detected_cache_write: number
  margin_input: number
  margin_output: number
  today: BusinessMetrics
  total: BusinessMetrics
  quality_24h: QualityMetrics
  recommendations: string[]
}

export interface PriceCompareModel {
  model_name: string
  channels: PriceCompareChannel[]
}

export interface ChannelSummary {
  channel_id: number
  channel_name: string
  model_count: number
  risk_count: number
  today: BusinessMetrics
  total: BusinessMetrics
}

export interface OperationsSummary {
  today: BusinessMetrics
  total: BusinessMetrics
  risk_channels: number
}

export interface ChannelPriceCompareData {
  generated_at: number
  local_group: string
  summary: OperationsSummary
  channels: ChannelSummary[]
  models: PriceCompareModel[]
  probe_errors: Record<string, string>
}
