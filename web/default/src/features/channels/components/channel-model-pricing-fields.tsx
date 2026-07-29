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
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useController, useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { getPricing } from '@/features/pricing/api'

import type { ChannelFormValues } from '../lib/channel-form'

type ModelPrice = {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
}

type PriceField = keyof ModelPrice

const EMPTY_PRICE: ModelPrice = {}

function parseRecord(value: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function readPrice(value: unknown): ModelPrice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return EMPTY_PRICE
  }
  const record = value as Record<string, unknown>
  const price: ModelPrice = {}
  for (const field of [
    'input',
    'output',
    'cache_read',
    'cache_write',
  ] as const) {
    if (typeof record[field] === 'number') {
      price[field] = record[field]
    }
  }
  return price
}

export function ChannelModelPricingFields() {
  const { t } = useTranslation()
  const form = useFormContext<ChannelFormValues>()
  const modelsValue = form.watch('models')
  const { data: pricingData } = useQuery({
    queryKey: ['pricing'],
    queryFn: getPricing,
    staleTime: 5 * 60 * 1000,
  })
  const mappingValue = form.watch('model_mapping')
  const { field: modelPricesField, fieldState: modelPricesFieldState } =
    useController({
      control: form.control,
      name: 'model_prices',
    })
  const pricesValue = modelPricesField.value
  const fixedPriceModels = useMemo(
    () =>
      new Set(
        (pricingData?.data ?? [])
          .filter((model) => model.quota_type === 1)
          .map((model) => model.model_name)
      ),
    [pricingData?.data]
  )
  const models = useMemo(
    () =>
      [
        ...new Set(
          String(modelsValue || '')
            .split(',')
            .map((model) => model.trim())
            .filter((model) => model && !fixedPriceModels.has(model))
        ),
      ].sort(),
    [fixedPriceModels, modelsValue]
  )
  const mapping = useMemo(() => parseRecord(mappingValue), [mappingValue])
  const prices = useMemo(() => parseRecord(pricesValue), [pricesValue])
  const hasIncompletePrice = useMemo(
    () =>
      models.some((model) => {
        if (prices[model] === undefined) return false
        const price = readPrice(prices[model])
        return (['input', 'output', 'cache_read', 'cache_write'] as const).some(
          (field) =>
            typeof price[field] !== 'number' || Number(price[field]) < 0
        )
      }),
    [models, prices]
  )

  const updatePrice = (model: string, field: PriceField, rawValue: string) => {
    const nextPrices = { ...prices }
    const nextPrice = { ...readPrice(prices[model]) }
    if (rawValue.trim() === '') {
      delete nextPrice[field]
    } else {
      const value = Number(rawValue)
      nextPrice[field] = Number.isFinite(value) && value >= 0 ? value : 0
    }
    if (Object.keys(nextPrice).length === 0) {
      delete nextPrices[model]
    } else {
      nextPrices[model] = nextPrice
    }
    modelPricesField.onChange(JSON.stringify(nextPrices))
    void form.trigger('model_prices')
  }

  return (
    <div className='border-border/70 bg-muted/20 space-y-4 rounded-lg border p-4'>
      <FormField
        control={form.control}
        name='upstream_group'
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t('Upstream billing group')}</FormLabel>
            <FormControl>
              <Input
                placeholder={t('For example: premium or ClaudeCode-Max')}
                {...field}
              />
            </FormControl>
            <FormDescription>
              {t('The pricing group assigned by the upstream provider.')}
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <div>
        <div className='mb-1 text-sm font-medium'>{t('Purchase prices')}</div>
        <p className='text-muted-foreground mb-3 text-xs'>
          {t(
            'USD per 1M tokens. Enter 0 when the upstream does not charge for a token category.'
          )}
        </p>
        {modelPricesFieldState.error || hasIncompletePrice ? (
          <p className='text-destructive mb-3 text-xs' role='alert'>
            {t(
              'Input, output, cache read, and cache write prices are required for each maintained model.'
            )}
          </p>
        ) : null}
        <div className='overflow-x-auto'>
          <table className='w-full min-w-[760px] border-collapse text-sm'>
            <thead>
              <tr className='border-border border-b text-left'>
                <th className='px-2 py-2 font-medium'>{t('Model')}</th>
                <th className='px-2 py-2 font-medium'>{t('Upstream model')}</th>
                <th className='px-2 py-2 font-medium'>{t('Input')}</th>
                <th className='px-2 py-2 font-medium'>{t('Output')}</th>
                <th className='px-2 py-2 font-medium'>{t('Cache Read')}</th>
                <th className='px-2 py-2 font-medium'>{t('Cache Write')}</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
                const price = readPrice(prices[model])
                const upstreamModel =
                  typeof mapping[model] === 'string' ? mapping[model] : model
                return (
                  <tr
                    key={model}
                    className='border-border/60 border-b last:border-0'
                  >
                    <td className='px-2 py-2 font-mono text-xs'>{model}</td>
                    <td className='text-muted-foreground px-2 py-2 font-mono text-xs'>
                      {upstreamModel}
                    </td>
                    {(
                      ['input', 'output', 'cache_read', 'cache_write'] as const
                    ).map((field) => (
                      <td key={field} className='px-2 py-2'>
                        <Input
                          aria-label={`${model} ${field}`}
                          className='h-8 min-w-24 tabular-nums'
                          min={0}
                          step='any'
                          type='number'
                          value={price[field] ?? ''}
                          onChange={(event) =>
                            updatePrice(model, field, event.target.value)
                          }
                        />
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
