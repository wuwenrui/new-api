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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { FormProvider, useForm } from 'react-hook-form'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getSystemOptionsForModel,
  updatePricingOptions,
} from '../../system-settings/api'
import type { ChannelFormValues } from '../lib/channel-form'
import { ChannelSellingPrices } from './channel-selling-prices'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key.replaceAll(/{{(\w+)}}/g, (_, name: string) =>
        String(values?.[name] ?? '')
      ),
  }),
}))
vi.mock('../../system-settings/api', () => ({
  getSystemOptionsForModel: vi.fn(),
  updatePricingOptions: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const auth = vi.hoisted(() => ({ role: 100 }))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ auth: { user: { role: auth.role } } }),
}))
const cost = { input: 2.5, output: 12.5, cache_read: 0.25, cache_write: 3.125 }
let saved: Record<string, number>
function response(model: string) {
  return {
    success: true,
    message: '',
    data: [
      { key: 'GroupRatio', value: '{"default":2,"vip":1}' },
      { key: 'ModelRatio', value: JSON.stringify({ existing: 1, ...saved }) },
      {
        key: 'CompletionRatioMeta',
        value: JSON.stringify({ [model]: { ratio: 5, locked: false } }),
      },
      { key: 'CacheRatio', value: JSON.stringify({ [model]: 0.1 }) },
      { key: 'CreateCacheRatio', value: JSON.stringify({ [model]: 1.25 }) },
    ],
  }
}
function Harness() {
  const form = useForm<ChannelFormValues>({
    defaultValues: {
      models: 'new,existing',
      group: ['default', 'vip'],
      model_prices: JSON.stringify({ new: cost, existing: cost }),
    },
  })
  return (
    <FormProvider {...form}>
      <form>
        <button
          type='button'
          onClick={() => form.setValue('models', 'new,existing,added')}
        >
          Add model
        </button>
        <button
          type='button'
          onClick={() =>
            form.setValue(
              'model_prices',
              JSON.stringify({ new: { ...cost, input: 5 }, existing: cost })
            )
          }
        >
          Change purchase
        </button>
        <ChannelSellingPrices />
      </form>
    </FormProvider>
  )
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  saved = {}
  auth.role = 100
  vi.mocked(getSystemOptionsForModel).mockImplementation(async (model) =>
    response(model)
  )
  vi.mocked(updatePricingOptions).mockImplementation(async (request) => {
    if (request.billing_mode === 'ratio') {
      saved[request.model_name] = request.model_ratio
    }
    return { success: true, message: '' }
  })
})
afterEach(cleanup)

describe('channel selling price panel', () => {
  it('detects newly selected models before channel save and never writes during calculation', async () => {
    mount()
    expect(
      await screen.findByText('1 model(s) have no selling price.')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText('Add model'))
    expect(
      await screen.findByText('2 model(s) have no selling price.')
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('new Target gross margin (%)'), {
      target: { value: '20' },
    })
    expect(screen.getByLabelText('new Input selling price')).toHaveValue(3.125)
    expect(updatePricingOptions).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Change purchase'))
    expect(screen.getByLabelText('new Input selling price')).toHaveValue(6.25)
  })
  it('fills only missing prices, converts the selected group, and verifies saving', async () => {
    mount()
    await screen.findByText('1 model(s) have no selling price.')
    fireEvent.change(screen.getByLabelText('Bulk target gross margin (%)'), {
      target: { value: '20' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Calculate missing prices' })
    )
    expect(screen.getByLabelText('new Input selling price')).toHaveValue(3.125)
    expect(screen.getByLabelText('existing Input selling price')).toHaveValue(4)
    fireEvent.click(
      screen.getByRole('button', { name: 'Save selling prices (1)' })
    )
    await waitFor(() =>
      expect(updatePricingOptions).toHaveBeenCalledExactlyOnceWith({
        model_name: 'new',
        billing_mode: 'ratio',
        model_ratio: 0.78125,
        completion_ratio: 5,
        cache_ratio: 0.1,
        create_cache_ratio: 1.25,
      })
    )
    await waitFor(() =>
      expect(
        screen.queryByText('1 model(s) have no selling price.')
      ).not.toBeInTheDocument()
    )
    fireEvent.change(screen.getByLabelText('Selling price group'), {
      target: { value: 'vip' },
    })
    expect(screen.getByLabelText('new Input selling price')).toHaveValue(1.5625)
  })
  it('retains drafts and errors after failed saves', async () => {
    vi.mocked(updatePricingOptions).mockResolvedValue({
      success: false,
      message: 'write rejected',
    })
    mount()
    await screen.findByText('1 model(s) have no selling price.')
    fireEvent.change(screen.getByLabelText('new Target gross margin (%)'), {
      target: { value: '20' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Save selling prices (1)' })
    )
    expect(await screen.findByText('write rejected')).toBeInTheDocument()
    expect(screen.getByLabelText('new Input selling price')).toHaveValue(3.125)
  })
  it('shows read failures without misreporting missing prices', async () => {
    vi.mocked(getSystemOptionsForModel).mockResolvedValue({
      success: false,
      message: 'permission denied',
      data: [],
    })
    mount()
    expect(
      (await screen.findAllByText('permission denied')).length
    ).toBeGreaterThan(0)
    expect(
      screen.queryByText('2 model(s) have no selling price.')
    ).not.toBeInTheDocument()
  })
  it('allows recalculation after refreshing a conflicting online price', async () => {
    mount()
    await screen.findByText('1 model(s) have no selling price.')
    fireEvent.change(screen.getByLabelText('new Target gross margin (%)'), {
      target: { value: '20' },
    })
    saved.new = 0.9
    fireEvent.click(
      screen.getByRole('button', { name: 'Save selling prices (1)' })
    )
    await screen.findByText(
      'Online prices changed. Refresh and recalculate before saving.'
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh online prices' })
    )
    await screen.findByText('Current selling price: $3.6')
    fireEvent.change(screen.getByLabelText('new Target gross margin (%)'), {
      target: { value: '25' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Save selling prices (1)' })
    )
    await waitFor(() => expect(updatePricingOptions).toHaveBeenCalledTimes(1))
  })
  it('does not request root-only options for an ordinary channel administrator', () => {
    auth.role = 10
    mount()
    expect(getSystemOptionsForModel).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('region', { name: 'Selling prices and gross margins' })
    ).not.toBeInTheDocument()
  })
  it('rejects invalid margins, keeps direct price edits local, and excludes incomplete purchase prices', async () => {
    mount()
    await screen.findByText('1 model(s) have no selling price.')
    fireEvent.click(screen.getByText('Add model'))
    await screen.findByText('2 model(s) have no selling price.')
    expect(
      screen.getByLabelText('added Target gross margin (%)')
    ).toBeDisabled()
    fireEvent.change(screen.getByLabelText('new Target gross margin (%)'), {
      target: { value: '100' },
    })
    expect(
      screen.getByRole('button', { name: 'Save selling prices (1)' })
    ).toBeDisabled()
    fireEvent.change(screen.getByLabelText('new Target gross margin (%)'), {
      target: { value: '20' },
    })
    fireEvent.change(screen.getByLabelText('new Input selling price'), {
      target: { value: '5' },
    })
    expect(screen.getAllByText('Gross margin: 50.00%').length).toBeGreaterThan(
      0
    )
    expect(
      screen.getByRole('button', { name: 'Save selling prices (1)' })
    ).toBeEnabled()
    expect(updatePricingOptions).not.toHaveBeenCalled()
  })
  it('keeps failed drafts while clearing successfully saved rows in a batch', async () => {
    vi.mocked(updatePricingOptions).mockImplementation(async (request) => {
      if (request.model_name === 'new') {
        return { success: false, message: 'write rejected' }
      }
      if (request.billing_mode === 'ratio') {
        saved[request.model_name] = request.model_ratio
      }
      return { success: true, message: '' }
    })
    mount()
    await screen.findByText('1 model(s) have no selling price.')
    fireEvent.change(screen.getByLabelText('new Target gross margin (%)'), {
      target: { value: '20' },
    })
    fireEvent.change(
      screen.getByLabelText('existing Target gross margin (%)'),
      { target: { value: '20' } }
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Save selling prices (2)' })
    )
    expect(
      await screen.findByText('1 saved, 1 failed. Failed drafts are retained.')
    ).toBeInTheDocument()
    expect(screen.getByLabelText('new Target gross margin (%)')).toHaveValue(20)
    expect(
      screen.getByLabelText('existing Target gross margin (%)')
    ).toHaveValue(null)
    expect(
      screen.getByRole('button', { name: 'Save selling prices (1)' })
    ).toBeEnabled()
  })
  it('refreshes other visible models sharing the changed pricing rule', async () => {
    saved.shared = 1
    vi.mocked(getSystemOptionsForModel).mockImplementation(async (model) => {
      const result = response(model)
      result.data = result.data.filter((option) => option.key !== 'ModelRatio')
      result.data.push(
        { key: 'PricingModelKey', value: 'shared' },
        { key: 'ModelRatio', value: JSON.stringify({ shared: saved.shared }) }
      )
      return result
    })
    vi.mocked(updatePricingOptions).mockImplementation(async (request) => {
      if (request.billing_mode === 'ratio') saved.shared = request.model_ratio
      return { success: true, message: '' }
    })
    mount()
    await waitFor(() =>
      expect(screen.getByLabelText('existing Input selling price')).toHaveValue(
        4
      )
    )
    fireEvent.change(screen.getByLabelText('new Target gross margin (%)'), {
      target: { value: '20' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Save selling prices (1)' })
    )
    await waitFor(() =>
      expect(screen.getByLabelText('existing Input selling price')).toHaveValue(
        3.125
      )
    )
  })
})
