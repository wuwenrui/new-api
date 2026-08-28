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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, assert, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import type { PriceCompareChannel } from '../../types'
import { PriceSyncDialog } from '../price-sync-dialog'

const modelsDevMock = vi.hoisted(() => ({
  providerCalls: 0,
  providerError: null as Error | null,
}))

vi.mock('@opencode-ai/models', () => ({
  Models: {
    make: () => {
      modelsDevMock.providerCalls += 1
      return {
        providers: async () => {
          if (modelsDevMock.providerError) throw modelsDevMock.providerError
          return {}
        },
      }
    },
  },
}))

const originalApiPut = api.put

const i18n = createInstance()
await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: { en: { translation: {} } },
})

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
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  })
  queryClient.setQueryData(['system-options', modelName], { data: [] })
  const renderDialog = async (value: PriceCompareChannel) => {
    const utils = render(
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
    await act(async () => {})
    return utils
  }
  return { queryClient, render: renderDialog }
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
  fireEvent.input(input, { target: { value } })
}

function assertOfficialUnavailableOnly() {
  const bodyText = document.body.textContent ?? ''
  expect(bodyText).toContain('Official model price could not be loaded')
  expect(bodyText).toContain(
    'Official pricing is unavailable for this model and provider.'
  )
  expect(bodyText).not.toContain(
    'Complete purchase price is required before syncing'
  )
  expect(bodyText).not.toContain('Cost profit rate must be at least 0')
  expect(bodyText).not.toContain('Selling price calculation overflowed')
}

function assertPurchasePriceMaintenanceOnly() {
  const bodyText = document.body.textContent ?? ''
  expect(bodyText).toContain(
    'Complete purchase price is required before syncing'
  )
  expect(bodyText).toContain(
    'Maintain complete input, output, cache read, and cache write purchase prices before syncing.'
  )
  expect(bodyText).not.toContain('Official model price could not be loaded')
  expect(bodyText).not.toContain('Cost profit rate must be at least 0')
  expect(bodyText).not.toContain('Selling price calculation overflowed')
  expect(applyButton().disabled).toBe(true)
}

describe('price sync dialog regressions', () => {
  afterEach(() => {
    modelsDevMock.providerCalls = 0
    modelsDevMock.providerError = null
    api.put = originalApiPut
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

    expect(document.body.textContent).toContain('Context pricing tiers')
    fireEvent.click(applyButton())
    await waitFor(() => expect(submitted.length).toBe(1))
    const request = submitted[0] as Record<string, unknown>
    expect(request.billing_mode).toBe('tiered_expr')
    const purchasePrice = request.purchase_price as Record<string, unknown>
    expect(purchasePrice.source).toBe('models_dev')
    expect((purchasePrice.tiers as unknown[]).length).toBe(1)
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
    expect(bodyText).toContain('Cost: $1.50 / $7.50')
    expect(bodyText).not.toContain('Context pricing tiers')
    const input = document.querySelector<HTMLInputElement>(
      'input[id="price-sync-cost-profit-rate"]'
    )
    expect(input?.value).toBe('5000')
    fireEvent.click(applyButton())
    await waitFor(() => expect(submitted.length).toBe(1))
    const request = submitted[0] as Record<string, unknown>
    expect(request.billing_mode).toBe('ratio')
    expect(request.channel_id).toBe(1)
    expect('billing_expr' in request).toBe(false)
    expect('upstream_provider' in request).toBe(false)
    const purchasePrice = request.purchase_price as Record<string, unknown>
    expect(purchasePrice).toEqual({
      input: 1.5,
      output: 7.5,
      cache_read: 0.15,
      cache_write: 1.875,
      source: 'manual',
    })

    modelsDevMock.providerCalls = 0
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
    expect(reopenedInput?.value).toBe('5000')
    expect(document.body.textContent).toContain(
      'Using manually maintained purchase price'
    )
    expect(document.body.textContent).not.toContain('Context pricing tiers')
    expect(modelsDevMock.providerCalls).toBe(0)
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

    expect(document.body.textContent).toContain(
      'Official model price could not be loaded'
    )
    expect(applyButton().disabled).toBe(true)
    await act(async () => {
      fireEvent.click(applyButton())
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(submitted.length).toBe(0)
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
    expect(bodyText).toContain('Using detected upstream price')
    expect(bodyText).not.toContain('Context pricing tiers')
    expect(modelsDevMock.providerCalls).toBe(0)
    fireEvent.click(applyButton())
    await waitFor(() => expect(submitted.length).toBe(1))
    const request = submitted[0] as Record<string, unknown>
    expect(request.billing_mode).toBe('ratio')
    expect('purchase_price' in request).toBe(false)
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
    expect(document.body.textContent).toContain(
      'Complete purchase price is required before syncing'
    )
    expect(modelsDevMock.providerCalls).toBe(0)
    expect(applyButton().disabled).toBe(true)
  })

  test('shows official loading failure separately from missing pricing', async () => {
    modelsDevMock.providerError = new Error('models.dev unavailable')
    const harness = createHarness()
    await harness.render(
      channel({
        status: 'unknown',
        price_source: 'missing',
        detected_available: false,
        uses_official_pricing: true,
      })
    )
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        'Official model price could not be loaded'
      )
    )
    assertOfficialUnavailableOnly()
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
    expect(applyButton().disabled).toBe(true)
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
    expect(applyButton().disabled).toBe(true)
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
    expect(bodyText).toContain('Selling price calculation overflowed')
    expect(bodyText).not.toContain('Official model price could not be loaded')
    expect(applyButton().disabled).toBe(true)
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
    expect(document.body.textContent).toContain(
      'Selling price calculation overflowed'
    )
    expect(document.body.textContent).not.toContain(
      'Cost profit rate must be at least 0'
    )
    expect(applyButton().disabled).toBe(true)
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
    expect(modelsDevMock.providerCalls).toBe(0)
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

    expect(document.body.textContent).toContain('Context pricing tiers')
    expect(document.body.textContent).not.toContain(
      'Complete purchase price is required before syncing'
    )
    expect(modelsDevMock.providerCalls).toBe(0)
  })
})
