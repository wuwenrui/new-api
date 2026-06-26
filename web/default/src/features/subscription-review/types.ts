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
export interface ApiResponse<T = unknown> {
  success?: boolean
  message?: string
  data?: T
}

export interface PendingManualSubscription {
  id: number
  user_id: number
  username: string
  email: string
  plan_id: number
  plan_title: string
  money: number
  payment_method: string
  payment_provider?: string
  create_time: number
  complete_time?: number
  trade_no: string
  status: string
}

export interface PendingManualSubscriptionPage {
  items: PendingManualSubscription[]
  total: number
}

export interface ManualOrderBreakdown {
  status?: string
  payment_method?: string
  count: number
  money: number
}

export interface ManualOrderSummary {
  total_count: number
  pending_count: number
  success_count: number
  failed_count: number
  expired_count: number
  total_money: number
  pending_money: number
  success_money: number
  failed_money: number
  expired_money: number
  by_status: ManualOrderBreakdown[]
  by_method: ManualOrderBreakdown[]
}

export interface ManualOrderQueryParams {
  page: number
  pageSize: number
  keyword?: string
  status?: string
  startTimestamp?: number
  endTimestamp?: number
}

export interface ManualSubscriptionOrderPage {
  items: PendingManualSubscription[]
  total: number
  summary: ManualOrderSummary
}
