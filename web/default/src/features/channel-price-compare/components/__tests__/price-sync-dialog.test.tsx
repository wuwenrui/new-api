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

let modelsDevProviderCalls = 0
const bunTestModule = await import(['bun', 'test'].join(':'))
bunTestModule.mock.module('@opencode-ai/models', () => ({
  Models: {
    make: () => {
      modelsDevProviderCalls += 1
      return { providers: async () => ({}) }
    },
  },
}))

// React modules are loaded after happy-dom globals so they bind to this DOM.
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { onlineManager, QueryClient, QueryClientProvider } =
  await import('@tanstack/react-query')
const { createInstance } = await import('i18next')
const { I18nextProvider, initReactI18next } = await import('react-i18next')
const { api } = await import('@/lib/api')
const { PriceSyncDialog } = await import('../price-sync-dialog')
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
  assert.equal(grids.length, 1, 'main comparison grid must be unique')
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
  assert.notEqual(labelIndex, -1, `row "${rowLabel}" missing in comparison`)
  const cell = grid.children[labelIndex + (column === 'current' ? 1 : 2)]
  assert.ok(cell)
  return cell.textContent?.trim() ?? ''
}

function tierBlock(card: HTMLElement, contextLabel: string): HTMLElement {
  const labels = [...card.querySelectorAll('div')].filter(
    (el) => el.textContent?.trim() === contextLabel
  )
  assert.equal(labels.length, 1, `tier "${contextLabel}" must be unique`)
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
  after(() => {
    domWindow.close()
  })

  afterEach(() => {
    modelsDevProviderCalls = 0
    api.put = originalApiPut
    onlineManager.setOnline(true)
  })

  test('uses manual purchase price before official pricing and explains the rate', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    })
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

    await act(async () => {
      queryClient.setQueryData(['system-options', 'gpt-5.6-sol'], {
        data: [{ key: 'QuotaPerUnit', value: '500000' }],
      })
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

    const bodyText = document.body.textContent ?? ''
    assert.ok(bodyText.includes('Using manually maintained purchase price'))
    assert.ok(bodyText.includes('Cost: $1.50 / $9.00'))
    assert.ok(!bodyText.includes('Using official model price'))
    assert.ok(!bodyText.includes('Context pricing tiers'))
    assert.equal(modelsDevProviderCalls, 0)
    assert.ok(bodyText.includes('Target cost profit rate (profit ÷ cost)'))
    assert.ok(
      bodyText.includes(
        '100% means the selling price is 2× cost; 455.56% means about 5.56× cost.'
      )
    )
    assert.ok(bodyText.includes('Gross margin'))
    assert.equal(costProfitRateInputIn(document.body).value, '455.56')

    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
  })

  test('submits manual purchase pricing as an explicit ratio request', async () => {
    const submittedRequests: unknown[] = []
    const putCalls: unknown[][] = []
    api.put = (async (...args: unknown[]) => {
      putCalls.push(args)
      submittedRequests.push(args[1])
      return { data: { success: true, message: '' } }
    }) as typeof api.put
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    })
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

    await act(async () => {
      queryClient.setQueryData(['system-options', 'gpt-5.6-sol'], {
        data: [{ key: 'QuotaPerUnit', value: '500000' }],
      })
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

    assert.equal(costProfitRateInputIn(document.body).value, '455.56')
    await act(async () => {
      applyButtonIn(document.body).click()
      await Promise.resolve()
    })

    assert.equal(putCalls.length, 1)
    assert.equal(putCalls[0]?.[0], '/api/option/pricing')
    assert.deepEqual(submittedRequests, [
      {
        model_name: 'gpt-5.6-sol',
        billing_mode: 'ratio',
        model_ratio: 4.166701,
        completion_ratio: 6,
        cache_ratio: 0.1,
        create_cache_ratio: 1,
      },
    ])

    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
  })

  test('defaults the target cost profit rate from detected cost once', async () => {
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

    const input = costProfitRateInputIn(document.body)
    // detected cost 2/8 vs local selling 6/20 -> lower cost profit rate 150
    assert.equal(input.value, '150')

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
      local_input: 9,
      local_output: 50,
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

    const input = costProfitRateInputIn(document.body)
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
    assert.equal(costProfitRateInputIn(document.body).value, '566.67')

    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
  })

  test('shows unbounded cost profit rate previews and keeps official cost visible when invalid', async () => {
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
    const channel = detectedChannel({
      uses_official_pricing: true,
      status: 'unknown',
      price_source: 'missing',
      detected_available: false,
      local_input: 9,
      local_output: 50,
    })
    await act(async () => {
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

    const input = costProfitRateInputIn(document.body)
    // official cost 5/30 at multiplier 0.25 vs selling 9/50 -> default 566.67
    assert.equal(input.value, '566.67')
    // no arbitrary HTML maximum/spinner cap; decimals step by 0.01
    assert.equal(input.hasAttribute('max'), false)
    assert.equal(input.getAttribute('min'), '0')
    assert.equal(input.getAttribute('step'), '0.01')

    const applyButton = () =>
      [...document.body.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Apply selling price'
      )
    assert.ok(applyButton())
    assert.equal(applyButton()?.disabled, false)

    const tierLabel = 'Context at least 272,000 tokens'
    // default cost profit rate 566.67: current sale 9/50 vs cost 1.25/7.50 ->
    // profit 7.75/42.50, margin 86.1%/85.0%; the screenshot example lands at
    // sale 8.33/50.00, profit 7.08/42.50, margin 85.0%/85.0%
    const card = previewCard()
    assert.equal(
      comparisonCell(card, 'Selling price', 'current'),
      '$9.00 / $50.00'
    )
    assert.equal(
      comparisonCell(card, 'Selling price', 'after'),
      '$8.33 / $50.00'
    )
    assert.equal(
      comparisonCell(card, 'Gross profit', 'current'),
      '$7.75 / $42.50'
    )
    assert.equal(
      comparisonCell(card, 'Gross profit', 'after'),
      '$7.08 / $42.50'
    )
    assert.equal(
      comparisonCell(card, 'Gross margin', 'current'),
      '86.1% / 85.0%'
    )
    assert.equal(comparisonCell(card, 'Gross margin', 'after'), '85.0% / 85.0%')
    const tier = tierBlock(card, tierLabel)
    assert.equal(tierRowValue(tier, 'Selling price'), '$16.67 / $75.00')
    assert.equal(tierRowValue(tier, 'Gross profit'), '$14.17 / $63.75')
    assert.equal(tierRowValue(tier, 'Gross margin'), '85.0% / 85.0%')

    // rate 100 doubles the official cost 1.25/7.50 to a 2.50/15.00 preview
    await act(async () => {
      changeInputValue(input, '100')
    })
    assert.equal(input.value, '100')
    assert.equal(
      comparisonCell(card, 'Selling price', 'current'),
      '$9.00 / $50.00'
    )
    assert.equal(
      comparisonCell(card, 'Selling price', 'after'),
      '$2.50 / $15.00'
    )
    assert.equal(
      comparisonCell(card, 'Gross profit', 'current'),
      '$7.75 / $42.50'
    )
    assert.equal(comparisonCell(card, 'Gross profit', 'after'), '$1.25 / $7.50')
    assert.equal(
      comparisonCell(card, 'Gross margin', 'current'),
      '86.1% / 85.0%'
    )
    assert.equal(comparisonCell(card, 'Gross margin', 'after'), '50.0% / 50.0%')
    // context tier cost 2.50/11.25 -> sale 5.00/22.50, profit 2.50/11.25,
    // margin 50.0%/50.0%
    assert.equal(tierRowValue(tier, 'Selling price'), '$5.00 / $22.50')
    assert.equal(tierRowValue(tier, 'Gross profit'), '$2.50 / $11.25')
    assert.equal(tierRowValue(tier, 'Gross margin'), '50.0% / 50.0%')
    assert.equal(applyButton()?.disabled, false)

    // rate 200 triples it; there is no business upper bound
    await act(async () => {
      changeInputValue(input, '200')
    })
    assert.equal(
      comparisonCell(card, 'Selling price', 'current'),
      '$9.00 / $50.00'
    )
    assert.equal(
      comparisonCell(card, 'Selling price', 'after'),
      '$3.75 / $22.50'
    )
    assert.equal(
      comparisonCell(card, 'Gross profit', 'current'),
      '$7.75 / $42.50'
    )
    assert.equal(
      comparisonCell(card, 'Gross profit', 'after'),
      '$2.50 / $15.00'
    )
    assert.equal(
      comparisonCell(card, 'Gross margin', 'current'),
      '86.1% / 85.0%'
    )
    assert.equal(comparisonCell(card, 'Gross margin', 'after'), '66.7% / 66.7%')
    assert.equal(tierRowValue(tier, 'Selling price'), '$7.50 / $33.75')
    assert.equal(tierRowValue(tier, 'Gross profit'), '$5.00 / $22.50')
    assert.equal(tierRowValue(tier, 'Gross margin'), '66.7% / 66.7%')
    assert.equal(applyButton()?.disabled, false)

    // a negative rate blanks the plan but never the official cost
    await act(async () => {
      changeInputValue(input, '-5')
    })
    assert.equal(input.value, '-5')
    assert.ok(
      document.body.textContent?.includes('Cost profit rate must be at least 0')
    )
    assert.ok(document.body.textContent?.includes('$1.25'))
    assert.ok(document.body.textContent?.includes('$7.50'))
    assert.equal(applyButton()?.disabled, true)

    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
  })
})
