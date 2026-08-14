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
import { after, afterEach, describe, test } from 'node:test'

import { Window } from 'happy-dom'

import type { PriceCompareChannel } from '../../types'

const domWindow = new Window()
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'SVGElement',
  'Node',
  'Element',
  'Event',
  'CustomEvent',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: domWindow[key],
  })
}

let providerCalls = 0
let providerError: Error | null = null
const bunTestModule = await import(['bun', 'test'].join(':'))
bunTestModule.mock.module('@opencode-ai/models', () => ({
  Models: {
    make: () => {
      providerCalls += 1
      return {
        providers: async () => {
          if (providerError) throw providerError
          return {}
        },
      }
    },
  },
}))

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { QueryClient, QueryClientProvider } =
  await import('@tanstack/react-query')
const { createInstance } = await import('i18next')
const { I18nextProvider, initReactI18next } = await import('react-i18next')
const { api } = await import('@/lib/api')
const { PriceSyncDialog } = await import('../price-sync-dialog')
const originalApiPut = api.put

const i18n = createInstance()
await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: { en: { translation: {} } },
})

const reactTestGlobals = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
reactTestGlobals.IS_REACT_ACT_ENVIRONMENT = true

const baseChannel: PriceCompareChannel = {
  channel_id: 1,
  channel_name: 'c',
  upstream_group: 'openai',
  upstream_model: 'gpt-5.6-sol',
  upstream_price_multiplier: 0.25,
  uses_official_pricing: false,
  priority: 0,
  weight: 1,
  routing_role: 'primary',
  status: 'ok',
  status_reason: '',
  price_source: 'detected',
  price_changed: false,
  detected_available: true,
  uses_fixed_price: false,
  fixed_price: 0,
  billing_mode: 'ratio',
  local_input: 9,
  local_output: 50,
  local_cache_read: 0,
  local_cache_write: 0,
  upstream_input: 2,
  upstream_output: 8,
  upstream_cache_read: 0.2,
  upstream_cache_write: 2,
  detected_input: 2,
  detected_output: 8,
  detected_cache_read: 0.2,
  detected_cache_write: 2,
  margin_input: 0,
  margin_output: 0,
  today: {
    requests: 0,
    revenue: 0,
    upstream_cost: 0,
    profit: 0,
    margin: 0,
    cost_available: false,
  },
  total: {
    requests: 0,
    revenue: 0,
    upstream_cost: 0,
    profit: 0,
    margin: 0,
    cost_available: false,
  },
  quality_24h: {
    successes: 0,
    errors: 0,
    success_rate: 0,
    average_use_time: 0,
    last_error_at: 0,
    last_error_code: '',
  },
  recommendations: [],
}

const channel = (
  overrides: Partial<PriceCompareChannel>
): PriceCompareChannel => ({ ...baseChannel, ...overrides })

const officialResolution = {
  providerId: 'openai',
  providerName: 'OpenAI',
  model: {
    models_dev_pricing: {
      base: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 },
      tiers: [
        {
          context_threshold: 272_000,
          input: 10,
          output: 45,
          cache_read: 1,
          cache_write: 12.5,
        },
      ],
      upstream_multiplier: 0.25,
    },
  },
}

const grok46OfficialResolution = {
  providerId: 'xai',
  providerName: 'xAI',
  model: {
    model_name: 'grok-4.6',
    models_dev_pricing: {
      base: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
      tiers: [
        {
          context_threshold: 200_000,
          input: 4,
          output: 20,
          cache_read: 0.4,
          cache_write: 5,
        },
        {
          context_threshold: 1_000_000,
          input: 6,
          output: 30,
          cache_read: 0.6,
          cache_write: 7.5,
        },
      ],
      upstream_multiplier: 0.25,
    },
  },
}

function createHarness(modelName = 'gpt-5.6-sol') {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  })
  queryClient.setQueryData(['system-options', modelName], { data: [] })
  const render = async (value: PriceCompareChannel) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <PriceSyncDialog
              open
              onOpenChange={() => undefined}
              modelName={modelName}
              channel={value}
              group='default'
            />
          </I18nextProvider>
        </QueryClientProvider>
      )
    })
  }
  const cleanup = async () => {
    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
  }
  return { queryClient, render, cleanup }
}

function applyButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === 'Apply selling price'
  )
  assert.ok(button)
  return button
}

function changeCostProfitRate(value: string) {
  const input = document.querySelector<HTMLInputElement>(
    'input[id="price-sync-cost-profit-rate"]'
  )
  assert.ok(input)
  const valueSetter = Object.getOwnPropertyDescriptor(
    domWindow.HTMLInputElement.prototype,
    'value'
  )?.set
  assert.ok(valueSetter)
  valueSetter.call(input, value)
  input.dispatchEvent(
    new domWindow.Event('input', { bubbles: true }) as unknown as Event
  )
}

function assertOfficialUnavailableOnly() {
  const bodyText = document.body.textContent ?? ''
  assert.ok(bodyText.includes('Official model price could not be loaded'))
  assert.ok(
    bodyText.includes(
      'Official pricing is unavailable for this model and provider.'
    )
  )
  assert.ok(
    !bodyText.includes('Complete purchase price is required before syncing')
  )
  assert.ok(!bodyText.includes('Cost profit rate must be at least 0'))
  assert.ok(!bodyText.includes('Selling price calculation overflowed'))
}

function assertPurchasePriceMaintenanceOnly() {
  const bodyText = document.body.textContent ?? ''
  assert.ok(
    bodyText.includes('Complete purchase price is required before syncing')
  )
  assert.ok(
    bodyText.includes(
      'Maintain complete input, output, cache read, and cache write purchase prices before syncing.'
    )
  )
  assert.ok(!bodyText.includes('Official model price could not be loaded'))
  assert.ok(!bodyText.includes('Cost profit rate must be at least 0'))
  assert.ok(!bodyText.includes('Selling price calculation overflowed'))
  assert.equal(applyButton().disabled, true)
}

describe('price sync dialog regressions', () => {
  after(() => domWindow.close())
  afterEach(() => {
    providerCalls = 0
    providerError = null
    api.put = originalApiPut
    document.body.replaceChildren()
  })

  test('reopens persisted Models.dev pricing and submits tiered source intact', async () => {
    const submitted: unknown[] = []
    api.put = (async (...args: unknown[]) => {
      submitted.push(args[1])
      return { data: { success: true, message: '' } }
    }) as typeof api.put
    const harness = createHarness()
    harness.queryClient.setQueryData(
      ['models-dev-official-price', 'gpt-5.6-sol', 'openai', 0.25],
      officialResolution
    )
    await harness.render(
      channel({
        price_source: 'models_dev',
        detected_available: false,
        uses_official_pricing: true,
        billing_mode: 'tiered_expr',
      })
    )

    assert.ok(document.body.textContent?.includes('Context pricing tiers'))
    await act(async () => {
      applyButton().click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const request = submitted[0] as Record<string, unknown>
    assert.equal(request.billing_mode, 'tiered_expr')
    const purchasePrice = request.purchase_price as Record<string, unknown>
    assert.equal(purchasePrice.source, 'models_dev')
    assert.equal((purchasePrice.tiers as unknown[]).length, 1)
    await harness.cleanup()
  })

  test('uses the grok-4.6 highest tier as one manual purchase price and reopens at 5000 percent', async () => {
    const submitted: unknown[] = []
    api.put = (async (...args: unknown[]) => {
      submitted.push(args[1])
      return { data: { success: true, message: '' } }
    }) as typeof api.put
    const harness = createHarness('grok-4.6')
    harness.queryClient.setQueryData(['system-options', 'grok-4.6'], {
      data: [{ key: 'QuotaPerUnit', value: '500000' }],
    })
    harness.queryClient.setQueryData(
      ['models-dev-official-price', 'grok-4.6', 'xai', 0.25],
      grok46OfficialResolution
    )
    await harness.render(
      channel({
        upstream_group: 'xai',
        upstream_model: 'grok-4.6',
        price_source: 'models_dev',
        detected_available: false,
        uses_official_pricing: true,
        billing_mode: 'tiered_expr',
        local_input: 76.5,
        local_output: 382.5,
      })
    )

    const bodyText = document.body.textContent ?? ''
    assert.ok(bodyText.includes('Cost: $1.50 / $7.50'))
    assert.ok(!bodyText.includes('Context pricing tiers'))
    const input = document.querySelector<HTMLInputElement>(
      'input[id="price-sync-cost-profit-rate"]'
    )
    assert.equal(input?.value, '5000')
    await act(async () => {
      applyButton().click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(submitted.length, 1)
    const request = submitted[0] as Record<string, unknown>
    assert.equal(request.billing_mode, 'ratio')
    assert.equal(request.channel_id, 1)
    assert.equal('billing_expr' in request, false)
    assert.equal('upstream_provider' in request, false)
    const purchasePrice = request.purchase_price as Record<string, unknown>
    assert.deepEqual(purchasePrice, {
      input: 1.5,
      output: 7.5,
      cache_read: 0.15,
      cache_write: 1.875,
      source: 'manual',
    })
    await harness.cleanup()

    providerCalls = 0
    const reopened = createHarness('grok-4.6')
    reopened.queryClient.setQueryData(['system-options', 'grok-4.6'], {
      data: [{ key: 'QuotaPerUnit', value: '500000' }],
    })
    await reopened.render(
      channel({
        upstream_group: 'xai',
        upstream_model: 'grok-4.6',
        price_source: 'manual',
        detected_available: false,
        uses_official_pricing: true,
        billing_mode: 'ratio',
        upstream_input: 1.5,
        upstream_output: 7.5,
        upstream_cache_read: 0.15,
        upstream_cache_write: 1.875,
        local_input: 76.5,
        local_output: 382.5,
      })
    )

    const reopenedInput = document.querySelector<HTMLInputElement>(
      'input[id="price-sync-cost-profit-rate"]'
    )
    assert.equal(reopenedInput?.value, '5000')
    assert.ok(
      document.body.textContent?.includes(
        'Using manually maintained purchase price'
      )
    )
    assert.ok(!document.body.textContent?.includes('Context pricing tiers'))
    assert.equal(providerCalls, 0)
    await reopened.cleanup()
  })

  test('does not submit grok-4.6 as ratio plus manual price when every tier is below 200K', async () => {
    const submitted: unknown[] = []
    api.put = (async (...args: unknown[]) => {
      submitted.push(args[1])
      return { data: { success: true, message: '' } }
    }) as typeof api.put
    const harness = createHarness('grok-4.6')
    harness.queryClient.setQueryData(['system-options', 'grok-4.6'], {
      data: [{ key: 'QuotaPerUnit', value: '500000' }],
    })
    harness.queryClient.setQueryData(
      ['models-dev-official-price', 'grok-4.6', 'xai', 0.25],
      {
        ...grok46OfficialResolution,
        model: {
          ...grok46OfficialResolution.model,
          models_dev_pricing: {
            ...grok46OfficialResolution.model.models_dev_pricing,
            tiers: [
              {
                context_threshold: 128_000,
                input: 4,
                output: 20,
                cache_read: 0.4,
                cache_write: 5,
              },
            ],
          },
        },
      }
    )
    await harness.render(
      channel({
        upstream_group: 'xai',
        upstream_model: 'grok-4.6',
        price_source: 'models_dev',
        detected_available: false,
        uses_official_pricing: true,
        billing_mode: 'tiered_expr',
      })
    )

    assert.ok(
      document.body.textContent?.includes(
        'Official model price could not be loaded'
      )
    )
    assert.equal(applyButton().disabled, true)
    await act(async () => {
      applyButton().click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(submitted.length, 0)
    await harness.cleanup()
  })

  test('uses detected ratio pricing before a persisted Models.dev fallback', async () => {
    const submitted: unknown[] = []
    api.put = (async (...args: unknown[]) => {
      submitted.push(args[1])
      return { data: { success: true, message: '' } }
    }) as typeof api.put
    const harness = createHarness()
    harness.queryClient.setQueryData(['system-options', 'gpt-5.6-sol'], {
      data: [{ key: 'QuotaPerUnit', value: '500000' }],
    })
    await harness.render(
      channel({
        price_source: 'models_dev',
        detected_available: true,
        uses_official_pricing: true,
        billing_mode: 'tiered_expr',
      })
    )

    const bodyText = document.body.textContent ?? ''
    assert.ok(bodyText.includes('Using detected upstream price'))
    assert.ok(!bodyText.includes('Context pricing tiers'))
    assert.equal(providerCalls, 0)
    await act(async () => {
      applyButton().click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const request = submitted[0] as Record<string, unknown>
    assert.equal(request.billing_mode, 'ratio')
    assert.equal('purchase_price' in request, false)
    await harness.cleanup()
  })

  test('shows missing purchase pricing without an explicit marker', async () => {
    const harness = createHarness()
    await harness.render(
      channel({
        status: 'unknown',
        price_source: 'missing',
        detected_available: false,
        uses_official_pricing: undefined,
      })
    )
    assert.ok(
      document.body.textContent?.includes(
        'Complete purchase price is required before syncing'
      )
    )
    assert.equal(providerCalls, 0)
    assert.equal(applyButton().disabled, true)
    await harness.cleanup()
  })

  test('shows official loading failure separately from missing pricing', async () => {
    providerError = new Error('models.dev unavailable')
    const harness = createHarness()
    await harness.render(
      channel({
        status: 'unknown',
        price_source: 'missing',
        detected_available: false,
        uses_official_pricing: true,
      })
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    assertOfficialUnavailableOnly()
    await harness.cleanup()
  })

  test('shows a zero official input cost as unavailable instead of overflow', async () => {
    const pricing = officialResolution.model.models_dev_pricing
    const harness = createHarness()
    harness.queryClient.setQueryData(
      ['models-dev-official-price', 'gpt-5.6-sol', 'openai', 0.25],
      {
        ...officialResolution,
        model: {
          ...officialResolution.model,
          models_dev_pricing: {
            ...pricing,
            base: { ...pricing.base, input: 0 },
          },
        },
      }
    )
    await harness.render(
      channel({
        status: 'unknown',
        price_source: 'missing',
        detected_available: false,
        uses_official_pricing: true,
      })
    )
    assertOfficialUnavailableOnly()
    assert.equal(applyButton().disabled, true)
    await harness.cleanup()
  })

  test('shows an invalid official tier as unavailable instead of overflow', async () => {
    const pricing = officialResolution.model.models_dev_pricing
    const harness = createHarness()
    harness.queryClient.setQueryData(
      ['models-dev-official-price', 'gpt-5.6-sol', 'openai', 0.25],
      {
        ...officialResolution,
        model: {
          ...officialResolution.model,
          models_dev_pricing: {
            ...pricing,
            tiers: [{ ...pricing.tiers[0], input: Number.NaN }],
          },
        },
      }
    )
    await harness.render(
      channel({
        status: 'unknown',
        price_source: 'missing',
        detected_available: false,
        uses_official_pricing: true,
      })
    )
    assertOfficialUnavailableOnly()
    assert.equal(applyButton().disabled, true)
    await harness.cleanup()
  })

  test('shows overflow only when valid official prices overflow the markup multiplication', async () => {
    const pricing = officialResolution.model.models_dev_pricing
    const harness = createHarness()
    harness.queryClient.setQueryData(
      ['models-dev-official-price', 'gpt-5.6-sol', 'openai', 0.25],
      {
        ...officialResolution,
        model: {
          ...officialResolution.model,
          models_dev_pricing: {
            ...pricing,
            base: { ...pricing.base, input: Number.MAX_VALUE },
          },
        },
      }
    )
    await harness.render(
      channel({
        status: 'unknown',
        price_source: 'missing',
        detected_available: false,
        uses_official_pricing: true,
      })
    )
    await act(async () => changeCostProfitRate('400'))
    const bodyText = document.body.textContent ?? ''
    assert.ok(bodyText.includes('Selling price calculation overflowed'))
    assert.ok(!bodyText.includes('Official model price could not be loaded'))
    assert.equal(applyButton().disabled, true)
    await harness.cleanup()
  })

  test('shows finite calculation overflow separately from invalid input', async () => {
    const harness = createHarness()
    harness.queryClient.setQueryData(['system-options', 'gpt-5.6-sol'], {
      data: [{ key: 'QuotaPerUnit', value: '500000' }],
    })
    await harness.render(
      channel({
        price_source: 'manual',
        detected_available: false,
        upstream_input: Number.MAX_VALUE,
        upstream_output: 1,
      })
    )
    assert.ok(
      document.body.textContent?.includes(
        'Selling price calculation overflowed'
      )
    )
    assert.ok(
      !document.body.textContent?.includes(
        'Cost profit rate must be at least 0'
      )
    )
    assert.equal(applyButton().disabled, true)
    await harness.cleanup()
  })

  test('shows a zero manual input cost as purchase pricing to maintain', async () => {
    const harness = createHarness()
    harness.queryClient.setQueryData(['system-options', 'gpt-5.6-sol'], {
      data: [{ key: 'QuotaPerUnit', value: '500000' }],
    })
    await harness.render(
      channel({
        price_source: 'manual',
        detected_available: false,
        uses_official_pricing: true,
        upstream_input: 0,
      })
    )

    assertPurchasePriceMaintenanceOnly()
    assert.equal(providerCalls, 0)
    await harness.cleanup()
  })

  test('falls back to official pricing for a zero detected input cost', async () => {
    const harness = createHarness()
    harness.queryClient.setQueryData(
      ['models-dev-official-price', 'gpt-5.6-sol', 'openai', 0.25],
      officialResolution
    )
    await harness.render(
      channel({ detected_input: 0, uses_official_pricing: true })
    )

    assert.ok(document.body.textContent?.includes('Context pricing tiers'))
    assert.ok(
      !document.body.textContent?.includes(
        'Complete purchase price is required before syncing'
      )
    )
    assert.equal(providerCalls, 0)
    await harness.cleanup()
  })
})
