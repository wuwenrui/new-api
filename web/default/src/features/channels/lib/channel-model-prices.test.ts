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
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { channelSchema } from '../types'
import {
  channelFormSchema,
  transformChannelToFormDefaults,
  transformFormDataToUpdatePayload,
} from './channel-form'

describe('channel model purchase prices', () => {
  test('round-trips upstream group and model prices while removing deselected models', () => {
    const channel = channelSchema.parse({
      id: 7,
      type: 1,
      key: '',
      status: 1,
      name: 'primary',
      created_time: 0,
      test_time: 0,
      response_time: 0,
      balance_updated_time: 0,
      models: 'gpt-primary',
      settings: JSON.stringify({
        pac_upstream_group: 'premium',
        model_prices: {
          'gpt-primary': {
            input: 2,
            output: 8,
            cache_read: 0.2,
            cache_write: 2.5,
          },
          'removed-model': { input: 99, output: 99 },
        },
      }),
    })

    const form = transformChannelToFormDefaults(channel)
    assert.equal(form.upstream_group, 'premium')
    assert.ok(form.model_prices)
    assert.deepEqual(JSON.parse(form.model_prices), {
      'gpt-primary': {
        input: 2,
        output: 8,
        cache_read: 0.2,
        cache_write: 2.5,
      },
      'removed-model': { input: 99, output: 99 },
    })

    const payload = transformFormDataToUpdatePayload(form, channel.id)
    const settings = JSON.parse(String(payload.settings))
    assert.equal(settings.pac_upstream_group, 'premium')
    assert.deepEqual(settings.model_prices, {
      'gpt-primary': {
        input: 2,
        output: 8,
        cache_read: 0.2,
        cache_write: 2.5,
      },
    })

    const incomplete = channelFormSchema.safeParse({
      ...form,
      model_prices: JSON.stringify({
        'gpt-primary': { input: 2, output: 8, cache_read: 0.2 },
      }),
    })
    assert.equal(incomplete.success, false)

    const zeroPrices = channelFormSchema.safeParse({
      ...form,
      model_prices: JSON.stringify({
        'gpt-primary': {
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
        },
      }),
    })
    assert.equal(zeroPrices.success, true)
  })
})
