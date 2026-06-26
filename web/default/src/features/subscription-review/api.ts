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
import { api } from '@/lib/api'
import { buildManualOrderQueryParams } from './lib'
import type {
  ApiResponse,
  ManualOrderQueryParams,
  ManualSubscriptionOrderPage,
  PendingManualSubscription,
  PendingManualSubscriptionPage,
} from './types'

export function isApiSuccess(response: ApiResponse): boolean {
  return response.success === true || response.message === 'success'
}

export async function getPendingManualSubscriptions(
  page: number,
  pageSize: number
): Promise<ApiResponse<PendingManualSubscriptionPage>> {
  const params = new URLSearchParams({
    p: page.toString(),
    page_size: pageSize.toString(),
  })
  const res = await api.get<ApiResponse<PendingManualSubscriptionPage>>(
    `/api/subscription/admin/manual/pending?${params.toString()}`
  )
  return res.data
}

export async function getManualSubscriptionOrders(
  params: ManualOrderQueryParams
): Promise<ApiResponse<ManualSubscriptionOrderPage>> {
  const query = buildManualOrderQueryParams(params)
  const res = await api.get<ApiResponse<ManualSubscriptionOrderPage>>(
    `/api/subscription/admin/manual/orders?${query}`
  )
  return res.data
}

export async function completeManualSubscription(
  tradeNo: string
): Promise<ApiResponse> {
  const res = await api.post<ApiResponse>(
    '/api/subscription/admin/manual/complete',
    { trade_no: tradeNo }
  )
  return res.data
}

export type { PendingManualSubscription }
