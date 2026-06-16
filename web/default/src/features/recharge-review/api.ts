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
import { buildCompletePayload } from './lib'
import type {
  ApiResponse,
  PendingManualTopUp,
  PendingManualTopUpPage,
} from './types'

// ============================================================================
// Recharge Review API Functions
// ============================================================================

/**
 * Whether an API response represents success.
 */
export function isApiSuccess(response: ApiResponse): boolean {
  return response.success === true || response.message === 'success'
}

/**
 * Fetch the paginated list of pending manual top-up orders (admin only).
 */
export async function getPendingManualTopUps(
  page: number,
  pageSize: number
): Promise<ApiResponse<PendingManualTopUpPage>> {
  const params = new URLSearchParams({
    p: page.toString(),
    page_size: pageSize.toString(),
  })
  const res = await api.get<ApiResponse<PendingManualTopUpPage>>(
    `/api/user/topup/pending-manual?${params.toString()}`
  )
  return res.data
}

/**
 * Complete a pending manual order with an admin-overridden amount (admin only).
 */
export async function completeOrderWithAmount(input: {
  trade_no: string
  amount: number
}): Promise<ApiResponse> {
  const payload = buildCompletePayload(input.trade_no, input.amount)
  const res = await api.post<ApiResponse>('/api/user/topup/complete', payload)
  return res.data
}

export type { PendingManualTopUp }
