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
  buildFinanceReportQuery,
  formatFinanceAmount,
  formatFinancePercent,
} from './financeReport';

describe('finance report helpers', () => {
  test('formats amounts and margins for admin cards', () => {
    expect(formatFinanceAmount(8.590917, '¥')).toBe('¥8.59');
    expect(formatFinanceAmount(0.041678, { symbol: '¥', rate: 7.3 })).toBe(
      '¥0.30',
    );
    expect(formatFinanceAmount(undefined, '$')).toBe('$0.00');
    expect(formatFinancePercent(53.291)).toBe('53.29%');
  });

  test('builds compact query params and drops empty filters', () => {
    const query = buildFinanceReportQuery({
      start_timestamp: 1000,
      end_timestamp: 2000,
      model_name: 'deepseek-v4-flash',
      username: '',
      channel: undefined,
    });

    expect(query).toBe(
      'start_timestamp=1000&end_timestamp=2000&model_name=deepseek-v4-flash',
    );
  });
});
