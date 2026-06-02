/*
Copyright (C) 2025 QuantumNous

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

const CONVERTED_DISPLAY_TYPES = new Set(['CNY', 'CUSTOM']);

function getPositiveRate(currencyConfig = {}) {
  const rate = Number(currencyConfig.rate);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}

export function shouldConvertTopupDisplay(currencyConfig = {}) {
  return CONVERTED_DISPLAY_TYPES.has(currencyConfig.type);
}

export function toTopupDisplayAmount(requestAmount, currencyConfig = {}) {
  const amount = Number(requestAmount || 0);
  if (!Number.isFinite(amount)) return 0;
  return shouldConvertTopupDisplay(currencyConfig)
    ? amount * getPositiveRate(currencyConfig)
    : amount;
}

export function toTopupRequestAmount(displayAmount, currencyConfig = {}) {
  const amount = Number(displayAmount || 0);
  if (!Number.isFinite(amount)) return 0;
  return shouldConvertTopupDisplay(currencyConfig)
    ? amount / getPositiveRate(currencyConfig)
    : amount;
}

export function formatTopupDisplayAmount(
  displayAmount,
  currencyConfig = {},
  digits = 2,
) {
  const symbol = currencyConfig.symbol || '$';
  const amount = Number(displayAmount || 0);
  return `${symbol}${Number.isFinite(amount) ? amount.toFixed(digits) : '0.00'}`;
}

export function getTopupInputPrecision(currencyConfig = {}) {
  return shouldConvertTopupDisplay(currencyConfig) ? 2 : 0;
}

export function getTopupAmountSectionHint() {
  return null;
}
