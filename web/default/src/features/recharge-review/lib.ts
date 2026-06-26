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
  CompleteOrderWithAmountPayload,
  ManualOrderQueryParams,
  ManualOrderSummary,
  PendingManualTopUp,
} from './types'

// ============================================================================
// Pure helpers (unit-testable, no side effects)
// ============================================================================

/**
 * Build the request payload for completing an order with an overridden amount.
 * Amount is normalized to a non-negative integer (the backend rejects <= 0).
 */
export function buildCompletePayload(
  tradeNo: string,
  amount: number
): CompleteOrderWithAmountPayload {
  const normalized = Number.isFinite(amount) ? Math.trunc(amount) : 0
  return {
    trade_no: tradeNo,
    amount: normalized,
  }
}

/**
 * Find the index of the order whose trade_no matches the given value.
 * Returns -1 when not found or when the lookup value is empty.
 */
export function findOrderIndexByTradeNo(
  list: readonly PendingManualTopUp[],
  tradeNo: string | undefined | null
): number {
  if (!tradeNo) return -1
  return list.findIndex((item) => item.trade_no === tradeNo)
}

/**
 * Preview what the user will receive for a given top-up amount.
 *
 * The admin edits `top_ups.amount` (an integer in USD/unit terms); the backend
 * credits `amount x QuotaPerUnit` quota. For the preview we show the amount in
 * unit terms, optionally prefixed with a currency symbol. Invalid / non-positive
 * amounts produce a stable placeholder so the dialog never shows NaN.
 */
export function previewQuota(amount: number, symbol = ''): string {
  const normalized = Number.isFinite(amount) ? Math.trunc(amount) : 0
  if (normalized <= 0) return `${symbol}0`
  return `${symbol}${normalized}`
}

export function buildManualOrderQueryParams(
  params: ManualOrderQueryParams
): string {
  const query = new URLSearchParams({
    p: String(params.page),
    page_size: String(params.pageSize),
  })
  const keyword = params.keyword?.trim() ?? ''
  if (keyword) query.set('keyword', keyword)
  if (params.status && params.status !== 'all') {
    query.set('status', params.status)
  }
  if (params.startTimestamp && params.startTimestamp > 0) {
    query.set('start_timestamp', String(params.startTimestamp))
  }
  if (params.endTimestamp && params.endTimestamp > 0) {
    query.set('end_timestamp', String(params.endTimestamp))
  }
  return query.toString()
}

export function normalizeManualOrderSummary(
  summary: Partial<ManualOrderSummary> | null | undefined
): ManualOrderSummary {
  return {
    total_count: summary?.total_count ?? 0,
    pending_count: summary?.pending_count ?? 0,
    success_count: summary?.success_count ?? 0,
    failed_count: summary?.failed_count ?? 0,
    expired_count: summary?.expired_count ?? 0,
    total_money: summary?.total_money ?? 0,
    pending_money: summary?.pending_money ?? 0,
    success_money: summary?.success_money ?? 0,
    failed_money: summary?.failed_money ?? 0,
    expired_money: summary?.expired_money ?? 0,
    by_status: summary?.by_status ?? [],
    by_method: summary?.by_method ?? [],
  }
}
