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
  create_time: number
  trade_no: string
  status: string
}

export interface PendingManualSubscriptionPage {
  items: PendingManualSubscription[]
  total: number
}
