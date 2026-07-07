import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { FILTER_ALL, SORT_OPTIONS } from '../constants'
import type { PricingModel } from '../types'
import { filterAndSortModels, filterByChannel } from './filters'

function pricingModel(
  modelName: string,
  channelIds: number[] = []
): PricingModel {
  return {
    id: channelIds[0] ?? 0,
    model_name: modelName,
    quota_type: 0,
    model_ratio: 1,
    completion_ratio: 1,
    enable_groups: ['default'],
    channels: channelIds.map((id) => ({
      id,
      name: `channel-${id}`,
      type: 1,
      priority: 0,
    })),
  }
}

describe('pricing channel filters', () => {
  test('keeps all models when channel filter is all', () => {
    assert.deepEqual(
      filterByChannel(
        [pricingModel('a', [1]), pricingModel('b', [2])],
        FILTER_ALL
      ).map((model) => model.model_name),
      ['a', 'b']
    )
  })

  test('keeps only models bound to the selected channel', () => {
    assert.deepEqual(
      filterByChannel(
        [pricingModel('a', [1, 2]), pricingModel('b', [3])],
        '2'
      ).map((model) => model.model_name),
      ['a']
    )
  })

  test('applies channel filter with the existing filter pipeline', () => {
    assert.deepEqual(
      filterAndSortModels(
        [pricingModel('b-model', [2]), pricingModel('a-model', [1])],
        {
          search: '',
          vendor: FILTER_ALL,
          group: FILTER_ALL,
          quotaType: FILTER_ALL,
          endpointType: FILTER_ALL,
          tag: FILTER_ALL,
          channel: '2',
          sortBy: SORT_OPTIONS.NAME,
        }
      ).map((model) => model.model_name),
      ['b-model']
    )
  })
})
