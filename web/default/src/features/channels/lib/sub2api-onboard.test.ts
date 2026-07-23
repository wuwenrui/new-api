import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { ProviderMap } from '@opencode-ai/models'

import {
  applyModelPricing,
  buildModelsDevBillingExpression,
  extractRatioMaps,
  RATIO_OPTION_KEYS,
  upstreamCostInUSD,
  upstreamCostOutUSD,
} from './newapi-onboard-pricing'
import {
  buildSub2APIProbeResult,
  listSub2APIProviders,
} from './sub2api-onboard'

const providers = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: {
      'gpt-priced': {
        id: 'gpt-priced',
        name: 'GPT Priced',
        modalities: { input: ['text'], output: ['text'] },
        cost: {
          input: 2,
          output: 8,
          cache_read: 0.2,
          tiers: [
            {
              input: 4,
              output: 12,
              cache_read: 0.4,
              tier: { type: 'context', size: 200_000 },
            },
          ],
        },
      },
      'image-only': {
        id: 'image-only',
        name: 'Image Only',
        modalities: { input: ['text'], output: ['image'] },
        cost: { input: 1, output: 1 },
      },
      unpriced: {
        id: 'unpriced',
        name: 'Unpriced',
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
  empty: {
    id: 'empty',
    name: 'Empty',
    models: {},
  },
} as unknown as ProviderMap

describe('Sub2API models.dev onboarding', () => {
  test('lists only providers with token-priced text models', () => {
    assert.deepEqual(listSub2APIProviders(providers), [
      { id: 'openai', name: 'OpenAI', modelCount: 1 },
    ])
  })

  test('converts provider models and applies the upstream multiplier', () => {
    const result = buildSub2APIProbeResult({
      providers,
      providerId: 'openai',
      baseUrl: 'https://www.lxddai.com/',
      upstreamMultiplier: 0.25,
    })

    assert.equal(result.base_url, 'https://www.lxddai.com')
    assert.deepEqual(result.group_ratio, { openai: 0.25 })
    assert.equal(result.models.length, 1)
    assert.equal(result.models[0].model_ratio, 1)
    assert.equal(result.models[0].completion_ratio, 4)
    assert.equal(
      result.models[0].models_dev_pricing?.tiers[0].context_threshold,
      200_000
    )
    assert.equal(upstreamCostInUSD(result.models[0], 0.25), 0.5)
    assert.equal(upstreamCostOutUSD(result.models[0], 0.25), 2)
  })

  test('rejects invalid multipliers and unknown providers', () => {
    assert.throws(
      () =>
        buildSub2APIProbeResult({
          providers,
          providerId: 'openai',
          baseUrl: 'https://www.lxddai.com',
          upstreamMultiplier: 0,
        }),
      /greater than 0/
    )
    assert.throws(
      () =>
        buildSub2APIProbeResult({
          providers,
          providerId: 'missing',
          baseUrl: 'https://www.lxddai.com',
          upstreamMultiplier: 0.25,
        }),
      /select a model provider/
    )
  })

  test('preserves context and cache pricing in the billing expression', () => {
    const [model] = buildSub2APIProbeResult({
      providers,
      providerId: 'openai',
      baseUrl: 'https://www.lxddai.com',
      upstreamMultiplier: 0.25,
    }).models

    assert.equal(
      buildModelsDevBillingExpression(model, 1.25, 5, 2.5),
      'len < 200000 ? tier("base", p * 0.5 + c * 2 + cr * 0.05) : tier("context_200000", p * 1 + c * 3 + cr * 0.1)'
    )
  })

  test('writes a tiered expression and scales it when sale prices change', () => {
    const [model] = buildSub2APIProbeResult({
      providers,
      providerId: 'openai',
      baseUrl: 'https://www.lxddai.com',
      upstreamMultiplier: 0.25,
    }).models
    const maps = extractRatioMaps([
      { key: 'ModelRatio', value: '{"gpt-priced":99}' },
    ])
    const updated = applyModelPricing(model, 2.5, 10, 2.5, maps)

    assert.equal(updated.ModelRatio['gpt-priced'], undefined)
    assert.equal(
      updated['billing_setting.billing_mode']['gpt-priced'],
      'tiered_expr'
    )
    assert.equal(
      updated['billing_setting.billing_expr']['gpt-priced'],
      'len < 200000 ? tier("base", p * 1 + c * 4 + cr * 0.1) : tier("context_200000", p * 2 + c * 6 + cr * 0.2)'
    )
  })

  test('writes billing expressions before enabling expression mode', () => {
    assert.ok(
      RATIO_OPTION_KEYS.indexOf('billing_setting.billing_expr') <
        RATIO_OPTION_KEYS.indexOf('billing_setting.billing_mode')
    )
  })
})
