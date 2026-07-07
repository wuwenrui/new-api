import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildPricingChannelLabels } from './channels'

describe('buildPricingChannelLabels', () => {
  test('formats channel name with id', () => {
    assert.deepEqual(
      buildPricingChannelLabels([
        { id: 12, name: 'pac-hunyuan-paid', type: 18, priority: 0 },
      ]),
      ['pac-hunyuan-paid #12']
    )
  })

  test('falls back to id when channel name is empty', () => {
    assert.deepEqual(
      buildPricingChannelLabels([{ id: 9, name: '  ', type: 1, priority: 10 }]),
      ['#9']
    )
  })
})
