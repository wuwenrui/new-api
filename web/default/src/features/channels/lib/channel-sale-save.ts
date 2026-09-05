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
import {
  getSystemOptionsForModel,
  updatePricingOptions,
} from '../../system-settings/api'
import {
  buildSaleRequest,
  readSaleSnapshot,
  SALE_FIELDS,
  scalePrices,
  snapshotSignature,
  type SaleDraft,
  type SaleSnapshot,
  type TokenPrices,
} from './channel-sale-pricing'

export async function loadChannelSale(model: string): Promise<SaleSnapshot> {
  const response = await getSystemOptionsForModel(model)
  if (!response.success || !Array.isArray(response.data)) {
    throw new Error(response.message || 'Could not load selling prices.')
  }
  return readSaleSnapshot(model, response.data)
}

export async function saveChannelSale(
  draft: SaleDraft,
  prices: TokenPrices
): Promise<SaleSnapshot> {
  const current = await loadChannelSale(draft.base.model)
  if (
    snapshotSignature(current, draft.group) !==
    snapshotSignature(draft.base, draft.group)
  ) {
    throw new Error(
      'Online prices changed. Refresh and recalculate before saving.'
    )
  }
  const request = buildSaleRequest(current, prices, current.groups[draft.group])
  const response = await updatePricingOptions(request)
  if (!response.success) {
    throw new Error(response.message || 'Could not save selling prices.')
  }
  const verified = await loadChannelSale(draft.base.model)
  const actual =
    verified.prices &&
    scalePrices(verified.prices, verified.groups[draft.group])
  if (
    verified.status !== 'ratio' ||
    !actual ||
    SALE_FIELDS.some(
      (field) =>
        !Number.isFinite(actual[field]) ||
        Math.abs(actual[field] - prices[field]) >
          1e-9 * Math.max(1, prices[field])
    )
  ) {
    throw new Error(
      'Could not verify the saved prices. Refresh before retrying.'
    )
  }
  return verified
}
