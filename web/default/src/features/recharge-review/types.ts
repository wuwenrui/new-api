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
// ============================================================================
// Recharge Review Type Definitions
// ============================================================================

/**
 * Generic API response envelope (mirrors the backend { success, message, data }).
 */
export interface ApiResponse<T = unknown> {
  success?: boolean
  message?: string
  data?: T
}

/**
 * A pending manual top-up order awaiting admin confirmation.
 */
export interface PendingManualTopUp {
  /** Top-up record id */
  id: number
  /** Owner user id */
  user_id: number
  /** Owner username (joined from users table) */
  username: string
  /** Owner email (joined from users table) */
  email: string
  /** Requested top-up amount (integer, USD/unit) */
  amount: number
  /** Actual money to collect (after group ratio / discount) */
  money: number
  /** Payment method identifier */
  payment_method: string
  /** Creation timestamp (seconds) */
  create_time: number
  /** Trade/order number */
  trade_no: string
  /** Order status */
  status: string
}

/**
 * Paginated pending manual top-up list payload.
 */
export interface PendingManualTopUpPage {
  items: PendingManualTopUp[]
  total: number
}

/**
 * Payload sent to the admin complete endpoint when overriding the amount.
 */
export interface CompleteOrderWithAmountPayload {
  trade_no: string
  amount: number
}
