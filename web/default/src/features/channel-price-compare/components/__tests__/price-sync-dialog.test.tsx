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
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, assert, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import type { PriceCompareChannel } from '../../types'
import { PriceSyncDialog } from '../price-sync-dialog'

const modelsDevMock = vi.hoisted(() => ({ providerCalls: 0 }))

vi.mock('@opencode-ai/models', () => ({
  Models: {
    make: () => {
      modelsDevMock.providerCalls += 1
      return { providers: async () => ({}) }
    },
  },
}))

const originalApiPut = api.put

const i18n = createInstance()
await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: {
    en: {
      translation: {},
    },
  },
})

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

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  })
}

function dialogTree(
  queryClient: QueryClient,
  channel: PriceCompareChannel,
  open: boolean
) {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <PriceSyncDialog
          open={open}
          onOpenChange={() => undefined}
          modelName='gpt-5.6-sol'
          channel={channel}
          group='default'
        />
      </I18nextProvider>
    </QueryClientProvider>
  )
}

function changeInputValue(input: HTMLInputElement, value: string) {
  fireEvent.input(input, { target: { value } })
}

function costProfitRateInputIn(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[id="price-sync-cost-profit-rate"]'
  )
  assert.ok(input)
  return input
}

function applyButtonIn(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === 'Apply selling price'
  )
  assert.ok(button)
  return button
}

// Scoped accessors for the preview comparison card. Assertions must address
// the exact row/cell instead of the whole body text, which would also match
// the cost card above the preview.
function previewCard(): HTMLElement {
  // the bordered card carries the unit note above the comparison grid
  const note = [...document.querySelectorAll('div')].find(
    (el) => el.textContent?.trim() === 'Input / Output · Per 1M tokens'
  )
  assert.ok(note, 'preview unit note missing')
  const card = note.parentElement
  assert.ok(card)
  return card
}

function mainComparisonGrid(card: HTMLElement): HTMLElement {
  // three rows (Selling price / Gross profit / Gross margin) x (label,
  // Current cell, After sync cell), preceded by a spacer and two column
  // headers: 2 + 3 * 3 = 11 -> spacer makes 12 direct children
  const grids = [...card.querySelectorAll('div')].filter(
    (el) =>
      el.children.length === 12 &&
      el.children[1].textContent?.trim() === 'Current' &&
      el.children[2].textContent?.trim() === 'After sync' &&
      el.children[3].textContent?.trim() === 'Selling price'
  )
  expect(grids.length, 'main comparison grid must be unique').toBe(1)
  return grids[0]
}

function comparisonCell(
  card: HTMLElement,
  rowLabel: string,
  column: 'current' | 'after'
): string {
  const grid = mainComparisonGrid(card)
  const labelIndex = [...grid.children].findIndex(
    (el) => el.textContent?.trim() === rowLabel
  )
  expect(labelIndex, `row "${rowLabel}" missing in comparison`).not.toBe(-1)
  const cell = grid.children[labelIndex + (column === 'current' ? 1 : 2)]
  assert.ok(cell)
  return cell.textContent?.trim() ?? ''
}

function tierBlock(card: HTMLElement, contextLabel: string): HTMLElement {
  const labels = [...card.querySelectorAll('div')].filter(
    (el) => el.textContent?.trim() === contextLabel
  )
  expect(labels.length, `tier "${contextLabel}" must be unique`).toBe(1)
  const block = labels[0].parentElement
  assert.ok(block)
  return block
}

function tierRowValue(block: HTMLElement, rowLabel: string): string {
  const grid = [...block.children].find(
    (el) => el.tagName === 'DIV' && el.children.length === 6
  )
  assert.ok(grid, `tier grid for "${rowLabel}" missing`)
  const label = [...grid.children].find(
    (el) => el.textContent?.trim() === rowLabel
  )
  assert.ok(label)
  const cell = label.nextElementSibling
  assert.ok(cell)
  return cell.textContent?.trim() ?? ''
}

describe('price sync dialog target cost profit rate', () => {
  afterEach(() => {
    modelsDevMock.providerCalls = 0
    api.put = originalApiPut
    onlineManager.setOnline(true)
  })

  test('uses manual purchase price before official pricing and explains the rate', async () => {
    const queryClient = makeQueryClient()
    const channel = detectedChannel({
      uses_official_pricing: true,
      price_source: 'manual',
      upstream_input: 1.5,
      upstream_output: 9,
      upstream_cache_read: 0.15,
      upstream_cache_write: 1.5,
      local_input: 9,
      local_output: 50,
    })
    queryClient.setQueryData(['system-options', 'gpt-5.6-sol'], {
      data: [{ key: 'QuotaPerUnit', value: '500000' }],
    })

    render(dialogTree(queryClient, channel, true))
    await act(async () => {})

    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('Using manually maintained purchase price')
    expect(bodyText).toContain('Cost: $1.50 / $9.00')
    expect(bodyText).not.toContain('Using official model price')
    expect(bodyText).not.toContain('Context pricing tiers')
    expect(modelsDevMock.providerCalls).toBe(0)
    expect(bodyText).toContain('Target cost profit rate (profit ÷ cost)')
    expect(bodyText).toContain(
      '100% means the selling price is 2× cost; 455.56% means about 5.56× cost.'
    )
    expect(bodyText).toContain('Gross margin')
    expect(costProfitRateInputIn(document.body).value).toBe('455.56')
  })

  test('submits manual purchase pricing as an explicit ratio request', async () => {
    const submittedRequests: unknown[] = []
    const putCalls: unknown[][] = []
    api.put = (async (...args: unknown[]) => {
      putCalls.push(args)
      submittedRequests.push(args[1])
      return { data: { success: true, message: '' } }
    }) as typeof api.put
    const queryClient = makeQueryClient()
    const channel = detectedChannel({
      uses_official_pricing: true,
      price_source: 'manual',
      upstream_input: 1.5,
      upstream_output: 9,
      upstream_cache_read: 0.15,
      upstream_cache_write: 1.5,
      local_input: 9,
      local_output: 50,
    })
    queryClient.setQueryData(['system-options', 'gpt-5.6-sol'], {
      data: [{ key: 'QuotaPerUnit', value: '500000' }],
    })

    render(dialogTree(queryClient, channel, true))
    await act(async () => {})

    expect(costProfitRateInputIn(document.body).value).toBe('455.56')
    fireEvent.click(applyButtonIn(document.body))

    await waitFor(() => expect(putCalls.length).toBe(1))
    expect(putCalls[0]?.[0]).toBe('/api/option/pricing')
    expect(submittedRequests).toEqual([
      {
        model_name: 'gpt-5.6-sol',
        billing_mode: 'ratio',
        model_ratio: 4.166701,
        completion_ratio: 6,
        cache_ratio: 0.1,
        create_cache_ratio: 1,
      },
    ])
  })

  test('defaults the target cost profit rate from detected cost once', async () => {
    const queryClient = makeQueryClient()

    render(dialogTree(queryClient, detectedChannel({}), true))
    await act(async () => {})

    const input = costProfitRateInputIn(document.body)
    // detected cost 2/8 vs local selling 6/20 -> lower cost profit rate 150
    expect(input.value).toBe('150')
  })

  test('preserves a pre-arrival edit and defaults again on reopen', async () => {
    onlineManager.setOnline(false)
    const queryClient = makeQueryClient()
    // New Sub2API rows carry an explicit official-price marker; hold their
    // Models.dev response so the user can edit before it arrives.
    const channel = detectedChannel({
      uses_official_pricing: true,
      status: 'unknown',
      price_source: 'missing',
      detected_available: false,
      local_input: 9,
      local_output: 50,
    })

    const { rerender } = render(dialogTree(queryClient, channel, true))
    await act(async () => {})

    const input = costProfitRateInputIn(document.body)
    changeInputValue(input, '45')
    expect(input.value).toBe('45')

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
    expect(input.value).toBe('45')

    rerender(dialogTree(queryClient, channel, false))
    await act(async () => {})
    rerender(dialogTree(queryClient, channel, true))
    await act(async () => {})
    expect(costProfitRateInputIn(document.body).value).toBe('566.67')
  })

  test('shows unbounded cost profit rate previews and keeps official cost visible when invalid', async () => {
    onlineManager.setOnline(false)
    const queryClient = makeQueryClient()
    const channel = detectedChannel({
      uses_official_pricing: true,
      status: 'unknown',
      price_source: 'missing',
      detected_available: false,
      local_input: 9,
      local_output: 50,
    })
    queryClient.setQueryData(['system-options', 'gpt-5.6-sol'], {
      data: [],
    })
    queryClient.setQueryData(
      ['models-dev-official-price', 'gpt-5.6-sol', 'openai', 0.25],
      {
        providerId: 'openai',
        providerName: 'OpenAI',
        model: {
          models_dev_pricing: {
            base: {
              input: 5,
              output: 30,
              cache_read: 0.5,
              cache_write: 6.25,
            },
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
    )

    render(dialogTree(queryClient, channel, true))
    await act(async () => {})

    const input = costProfitRateInputIn(document.body)
    // official cost 5/30 at multiplier 0.25 vs selling 9/50 -> default 566.67
    expect(input.value).toBe('566.67')
    // no arbitrary HTML maximum/spinner cap; decimals step by 0.01
    expect(input.hasAttribute('max')).toBe(false)
    expect(input.getAttribute('min')).toBe('0')
    expect(input.getAttribute('step')).toBe('0.01')

    const applyButton = () =>
      [...document.body.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Apply selling price'
      )
    assert.ok(applyButton())
    expect(applyButton()?.disabled).toBe(false)

    const tierLabel = 'Context at least 272,000 tokens'
    // default cost profit rate 566.67: current sale 9/50 vs cost 1.25/7.50 ->
    // profit 7.75/42.50, margin 86.1%/85.0%; the screenshot example lands at
    // sale 8.33/50.00, profit 7.08/42.50, margin 85.0%/85.0%
    const card = previewCard()
    expect(comparisonCell(card, 'Selling price', 'current')).toBe(
      '$9.00 / $50.00'
    )
    expect(comparisonCell(card, 'Selling price', 'after')).toBe(
      '$8.33 / $50.00'
    )
    expect(comparisonCell(card, 'Gross profit', 'current')).toBe(
      '$7.75 / $42.50'
    )
    expect(comparisonCell(card, 'Gross profit', 'after')).toBe(
      '$7.08 / $42.50'
    )
    expect(comparisonCell(card, 'Gross margin', 'current')).toBe(
      '86.1% / 85.0%'
    )
    expect(comparisonCell(card, 'Gross margin', 'after')).toBe('85.0% / 85.0%')
    const tier = tierBlock(card, tierLabel)
    expect(tierRowValue(tier, 'Selling price')).toBe('$16.67 / $75.00')
    expect(tierRowValue(tier, 'Gross profit')).toBe('$14.17 / $63.75')
    expect(tierRowValue(tier, 'Gross margin')).toBe('85.0% / 85.0%')

    // rate 100 doubles the official cost 1.25/7.50 to a 2.50/15.00 preview
    changeInputValue(input, '100')
    expect(input.value).toBe('100')
    expect(comparisonCell(card, 'Selling price', 'current')).toBe(
      '$9.00 / $50.00'
    )
    expect(comparisonCell(card, 'Selling price', 'after')).toBe(
      '$2.50 / $15.00'
    )
    expect(comparisonCell(card, 'Gross profit', 'current')).toBe(
      '$7.75 / $42.50'
    )
    expect(comparisonCell(card, 'Gross profit', 'after')).toBe('$1.25 / $7.50')
    expect(comparisonCell(card, 'Gross margin', 'current')).toBe(
      '86.1% / 85.0%'
    )
    expect(comparisonCell(card, 'Gross margin', 'after')).toBe('50.0% / 50.0%')
    // context tier cost 2.50/11.25 -> sale 5.00/22.50, profit 2.50/11.25,
    // margin 50.0%/50.0%
    expect(tierRowValue(tier, 'Selling price')).toBe('$5.00 / $22.50')
    expect(tierRowValue(tier, 'Gross profit')).toBe('$2.50 / $11.25')
    expect(tierRowValue(tier, 'Gross margin')).toBe('50.0% / 50.0%')
    expect(applyButton()?.disabled).toBe(false)

    // rate 200 triples it; there is no business upper bound
    changeInputValue(input, '200')
    expect(comparisonCell(card, 'Selling price', 'current')).toBe(
      '$9.00 / $50.00'
    )
    expect(comparisonCell(card, 'Selling price', 'after')).toBe(
      '$3.75 / $22.50'
    )
    expect(comparisonCell(card, 'Gross profit', 'current')).toBe(
      '$7.75 / $42.50'
    )
    expect(comparisonCell(card, 'Gross profit', 'after')).toBe(
      '$2.50 / $15.00'
    )
    expect(comparisonCell(card, 'Gross margin', 'current')).toBe(
      '86.1% / 85.0%'
    )
    expect(comparisonCell(card, 'Gross margin', 'after')).toBe('66.7% / 66.7%')
    expect(tierRowValue(tier, 'Selling price')).toBe('$7.50 / $33.75')
    expect(tierRowValue(tier, 'Gross profit')).toBe('$5.00 / $22.50')
    expect(tierRowValue(tier, 'Gross margin')).toBe('66.7% / 66.7%')
    expect(applyButton()?.disabled).toBe(false)

    // a negative rate blanks the plan but never the official cost
    changeInputValue(input, '-5')
    expect(input.value).toBe('-5')
    expect(document.body.textContent).toContain(
      'Cost profit rate must be at least 0'
    )
    expect(document.body.textContent).toContain('$1.25')
    expect(document.body.textContent).toContain('$7.50')
    expect(applyButton()?.disabled).toBe(true)
  })
})
