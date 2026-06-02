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

import { describe, expect, test } from 'bun:test';
import {
  formatTopupDisplayAmount,
  toTopupDisplayAmount,
  toTopupRequestAmount,
} from './topupCurrency';

describe('topup currency display helpers', () => {
  test('converts request amount to CNY display amount', () => {
    const currency = { type: 'CNY', symbol: '¥', rate: 7.3 };

    expect(toTopupDisplayAmount(1, currency)).toBe(7.3);
    expect(formatTopupDisplayAmount(7.3, currency)).toBe('¥7.30');
  });

  test('converts CNY display amount back to request amount', () => {
    const currency = { type: 'CNY', symbol: '¥', rate: 7.3 };

    expect(toTopupRequestAmount(73, currency)).toBe(10);
  });

  test('keeps USD request and display amounts unchanged', () => {
    const currency = { type: 'USD', symbol: '$', rate: 1 };

    expect(toTopupDisplayAmount(10, currency)).toBe(10);
    expect(toTopupRequestAmount(10, currency)).toBe(10);
    expect(formatTopupDisplayAmount(10, currency)).toBe('$10.00');
  });
});
