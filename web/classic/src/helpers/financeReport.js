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

function storageGet(key) {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(key);
}

function safeStatus() {
  try {
    return JSON.parse(storageGet('status') || '{}');
  } catch (e) {
    return {};
  }
}

function finiteRate(value, fallback) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}

export function formatFinanceAmount(value, currency = '¥') {
  const numeric = Number(value);
  const amount = Number.isFinite(numeric) ? numeric : 0;
  const config =
    typeof currency === 'string'
      ? { symbol: currency, rate: 1 }
      : {
          symbol: currency?.symbol || '¥',
          rate: finiteRate(currency?.rate, 1),
        };
  return `${config.symbol}${(amount * config.rate).toFixed(2)}`;
}

export function getFinanceCurrencyConfig() {
  const type = storageGet('quota_display_type') || 'USD';
  const status = safeStatus();

  if (type === 'CNY') {
    return {
      symbol: '¥',
      rate: finiteRate(status?.usd_exchange_rate, 1),
      type,
    };
  }
  if (type === 'CUSTOM') {
    return {
      symbol: status?.custom_currency_symbol || '¤',
      rate: finiteRate(status?.custom_currency_exchange_rate, 1),
      type,
    };
  }
  return { symbol: '$', rate: 1, type };
}

export function getFinanceCurrencySymbol() {
  const { symbol } = getFinanceCurrencyConfig();
  return symbol;
}

export function formatFinancePercent(value) {
  const numeric = Number(value);
  const percent = Number.isFinite(numeric) ? numeric : 0;
  return `${percent.toFixed(2)}%`;
}

export function buildFinanceReportQuery(params = {}) {
  const orderedKeys = [
    'start_timestamp',
    'end_timestamp',
    'model_name',
    'username',
    'group',
    'channel',
  ];
  const search = new URLSearchParams();
  orderedKeys.forEach((key) => {
    const value = params[key];
    if (value === undefined || value === null || value === '') return;
    search.set(key, String(value));
  });
  return search.toString();
}
