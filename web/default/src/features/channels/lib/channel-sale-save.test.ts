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
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getSystemOptionsForModel,
  updatePricingOptions,
} from '../../system-settings/api'
import { readSaleSnapshot } from './channel-sale-pricing'
import { saveChannelSale } from './channel-sale-save'

vi.mock('../../system-settings/api', () => ({
  getSystemOptionsForModel: vi.fn(),
  updatePricingOptions: vi.fn(),
}))
const options = (input?: number) => ({
  success: true,
  message: '',
  data: [
    { key: 'GroupRatio', value: '{"default":1}' },
    { key: 'CompletionRatioMeta', value: '{"m":{"ratio":5,"locked":false}}' },
    {
      key: 'ModelRatio',
      value: JSON.stringify(input === undefined ? {} : { m: input / 2 }),
    },
    { key: 'CacheRatio', value: '{"m":0.1}' },
    { key: 'CreateCacheRatio', value: '{"m":1.25}' },
  ],
})
const prices = { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 }
const draft = {
  base: readSaleSnapshot('m', options().data),
  group: 'default',
  margin: '20',
}

describe('saving channel selling prices', () => {
  beforeEach(() => vi.resetAllMocks())
  it('writes only the model price and verifies the effective four prices', async () => {
    vi.mocked(getSystemOptionsForModel)
      .mockResolvedValueOnce(options())
      .mockResolvedValueOnce(options(2))
    vi.mocked(updatePricingOptions).mockResolvedValue({
      success: true,
      message: '',
    })
    const result = await saveChannelSale(draft, prices)
    expect(result.prices).toEqual(prices)
    expect(updatePricingOptions).toHaveBeenCalledExactlyOnceWith({
      model_name: 'm',
      billing_mode: 'ratio',
      model_ratio: 1,
      completion_ratio: 5,
      cache_ratio: 0.1,
      create_cache_ratio: 1.25,
    })
  })
  it('rejects concurrent changes before writing', async () => {
    vi.mocked(getSystemOptionsForModel).mockResolvedValue(options(3))
    await expect(saveChannelSale(draft, prices)).rejects.toThrow('changed')
    expect(updatePricingOptions).not.toHaveBeenCalled()
  })
  it('treats success:false reads as failures rather than missing prices', async () => {
    vi.mocked(getSystemOptionsForModel).mockResolvedValue({
      success: false,
      message: 'denied',
      data: [],
    })
    await expect(saveChannelSale(draft, prices)).rejects.toThrow('denied')
    expect(updatePricingOptions).not.toHaveBeenCalled()
  })
  it('does not report success when a write is rejected or readback differs', async () => {
    vi.mocked(getSystemOptionsForModel).mockResolvedValue(options())
    vi.mocked(updatePricingOptions).mockResolvedValueOnce({
      success: false,
      message: 'locked',
    })
    await expect(saveChannelSale(draft, prices)).rejects.toThrow('locked')
    vi.mocked(updatePricingOptions).mockResolvedValueOnce({
      success: true,
      message: '',
    })
    await expect(saveChannelSale(draft, prices)).rejects.toThrow('verify')
    expect(updatePricingOptions).toHaveBeenCalledTimes(2)
  })
})
