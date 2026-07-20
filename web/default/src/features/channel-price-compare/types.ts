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

export type PriceCompareStatus = 'ok' | 'unknown'

export interface PriceCompareChannel {
  channel_id: number
  channel_name: string
  upstream_base: string
  upstream_group: string
  priority: number
  status: PriceCompareStatus
  status_reason: string
  local_input: number
  local_output: number
  local_cache_read: number
  local_cache_write: number
  upstream_input: number
  upstream_output: number
  upstream_cache_read: number
  upstream_cache_write: number
  margin_input: number
  margin_output: number
}

export interface PriceCompareModel {
  model_name: string
  channels: PriceCompareChannel[]
}

export interface ChannelPriceCompareData {
  generated_at: number
  local_group: string
  models: PriceCompareModel[]
  probe_errors: Record<string, string>
}
