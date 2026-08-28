import { describe, expect, test } from 'vitest'

import { buildPricingChannelLabels } from './channels'

describe('buildPricingChannelLabels', () => {
  test('formats channel name with id', () => {
    expect(
      buildPricingChannelLabels([
        { id: 12, name: 'pac-hunyuan-paid', type: 18, priority: 0 },
      ])
    ).toEqual(['pac-hunyuan-paid #12'])
  })

  test('falls back to id when channel name is empty', () => {
    expect(
      buildPricingChannelLabels([{ id: 9, name: '  ', type: 1, priority: 10 }])
    ).toEqual(['#9'])
  })
})
