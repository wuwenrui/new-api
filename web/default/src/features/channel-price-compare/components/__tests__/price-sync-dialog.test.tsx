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
const domGlobals = [
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
] as const

for (const key of domGlobals) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: domWindow[key],
  })
}

// React modules are loaded after happy-dom globals so they bind to this DOM.
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { onlineManager, QueryClient, QueryClientProvider } =
  await import('@tanstack/react-query')
const { createInstance } = await import('i18next')
const { I18nextProvider, initReactI18next } = await import('react-i18next')
const { PriceSyncDialog } = await import('../price-sync-dialog')

const i18n = createInstance()
await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: {
    en: {
      translation: {},
    },
  },
})

const reactTestGlobals = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
reactTestGlobals.IS_REACT_ACT_ENVIRONMENT = true

function detectedChannel(
  overrides: Partial<PriceCompareChannel>
): PriceCompareChannel {
  return {
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
    // Model billing mode is global; a non-Sub2API channel still uses its detected cost.
    billing_mode: 'tiered_expr',
    local_input: 6,
    local_output: 20,
    local_cache_read: 0.6,
    local_cache_write: 6,
    upstream_input: 2,
    upstream_output: 8,
    upstream_cache_read: 0.2,
    upstream_cache_write: 2,
    detected_input: 2,
    detected_output: 8,
    detected_cache_read: 0.2,
    detected_cache_write: 2,
    margin_input: 66.66666666666666,
    margin_output: 60,
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
    ...overrides,
  }
}

function changeInputValue(input: HTMLInputElement, value: string) {
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

function marginInputIn(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[id="price-sync-margin"]'
  )
  assert.ok(input)
  return input
}

describe('price sync dialog target margin default', () => {
  after(() => {
    domWindow.close()
  })

  afterEach(() => {
    onlineManager.setOnline(true)
  })

  test('defaults the target margin from the current detected margin once', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    })

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <PriceSyncDialog
              open
              onOpenChange={() => undefined}
              modelName='gpt-5.6-sol'
              channel={detectedChannel({})}
              group='default'
            />
          </I18nextProvider>
        </QueryClientProvider>
      )
    })

    const input = marginInputIn(document.body)
    // detected cost 2/8 vs local selling 6/20 -> lower margin 60
    assert.equal(input.value, '60')

    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
  })

  test('preserves a pre-arrival edit and defaults again on reopen', async () => {
    onlineManager.setOnline(false)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    })
    // New Sub2API rows carry an explicit official-price marker; hold their
    // Models.dev response so the user can edit before it arrives.
    const channel = detectedChannel({
      uses_official_pricing: true,
      status: 'unknown',
      price_source: 'missing',
      detected_available: false,
      local_input: 18,
      local_output: 100,
    })

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <PriceSyncDialog
              open
              onOpenChange={() => undefined}
              modelName='gpt-5.6-sol'
              channel={channel}
              group='default'
            />
          </I18nextProvider>
        </QueryClientProvider>
      )
    })

    const input = marginInputIn(document.body)
    await act(async () => {
      changeInputValue(input, '45')
    })
    assert.equal(input.value, '45')

    await act(async () => {
      queryClient.setQueryData(
        ['models-dev-official-price', 'gpt-5.6-sol', 'openai', 0.25],
        {
          providerId: 'openai',
          providerName: 'OpenAI',
          model: {
            models_dev_pricing: {
              base: { input: 5, output: 30, cache_read: 0, cache_write: 0 },
              tiers: [],
              upstream_multiplier: 0.25,
            },
          },
        }
      )
    })
    assert.equal(input.value, '45')

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <PriceSyncDialog
              open={false}
              onOpenChange={() => undefined}
              modelName='gpt-5.6-sol'
              channel={channel}
              group='default'
            />
          </I18nextProvider>
        </QueryClientProvider>
      )
    })
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <PriceSyncDialog
              open
              onOpenChange={() => undefined}
              modelName='gpt-5.6-sol'
              channel={channel}
              group='default'
            />
          </I18nextProvider>
        </QueryClientProvider>
      )
    })
    assert.equal(marginInputIn(document.body).value, '92.5')

    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
  })
})
