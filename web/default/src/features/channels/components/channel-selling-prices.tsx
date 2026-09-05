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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { useChannelSellingPrices } from '../hooks/use-channel-selling-prices'
import { ChannelSellingPriceRow } from './channel-selling-price-row'

export function ChannelSellingPrices() {
  const isRoot = useAuthStore(
    (state) => state.auth.user?.role === ROLE.SUPER_ADMIN
  )
  return isRoot ? <ChannelSellingPricesContent /> : null
}

function ChannelSellingPricesContent() {
  const { t } = useTranslation()
  const state = useChannelSellingPrices()
  const [bulkMargin, setBulkMargin] = useState('20')
  const missing = state.rows.filter(
    (row) => row.snapshot?.status === 'missing' && !row.readFailed
  )
  const eligible = missing.filter(
    (row) => row.cost && row.cost.input > 0 && !row.loading
  )
  const margin = Number(bulkMargin)
  const validMargin =
    bulkMargin.trim() !== '' &&
    Number.isFinite(margin) &&
    margin >= 0 &&
    margin < 100
  if (!state.rows.length) return null
  return (
    <section
      aria-label={t('Selling prices and gross margins')}
      className='border-border/70 bg-background space-y-4 rounded-lg border p-4'
    >
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='space-y-1'>
          <h3 className='text-sm font-semibold'>
            {t('Selling prices and gross margins')}
          </h3>
          <p className='text-muted-foreground text-xs'>
            {t(
              'USD per 1M tokens. Gross margin = (selling price − purchase price) / selling price.'
            )}
          </p>
        </div>
        <Button
          type='button'
          size='sm'
          variant='ghost'
          disabled={state.saving}
          onClick={() => void state.refresh()}
        >
          {t('Refresh online prices')}
        </Button>
      </div>
      <p className='text-muted-foreground text-xs'>
        {t(
          'Selling prices are shared by all channels with the same model name. Saving here updates global model pricing independently of channel saving.'
        )}
      </p>
      <p className='text-muted-foreground text-xs'>
        {t(
          'Calculations use the purchase prices currently entered above; save the channel separately to persist purchase changes.'
        )}
      </p>
      {missing.length > 0 && (
        <p
          role='status'
          className='rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm'
        >
          {t('{{count}} model(s) have no selling price.', {
            count: missing.length,
          })}
        </p>
      )}
      <fieldset disabled={state.saving} className='space-y-4'>
        <legend className='sr-only'>{t('Selling price controls')}</legend>
        <div className='flex flex-wrap items-end gap-3'>
          <label className='space-y-1 text-xs'>
            {t('Selling price group')}
            <select
              aria-label={t('Selling price group')}
              className='border-input bg-background block h-9 rounded-md border px-3 text-sm'
              value={state.group}
              onChange={(event) => state.setGroup(event.target.value)}
            >
              {(state.groups.length ? state.groups : ['default']).map(
                (group) => (
                  <option key={group} value={group}>
                    {group}
                  </option>
                )
              )}
            </select>
          </label>
          <label className='space-y-1 text-xs'>
            {t('Bulk target gross margin (%)')}
            <Input
              type='number'
              min={0}
              max={99.99}
              step='any'
              aria-label={t('Bulk target gross margin (%)')}
              className='h-9 w-32'
              value={bulkMargin}
              onChange={(event) => setBulkMargin(event.target.value)}
            />
          </label>
          <Button
            type='button'
            variant='outline'
            disabled={!validMargin || !eligible.length}
            onClick={() =>
              eligible.forEach(
                (row) =>
                  row.snapshot &&
                  state.setDraft(row.snapshot, { margin: bulkMargin })
              )
            }
          >
            {t('Calculate missing prices')}
          </Button>
        </div>
        {missing.length > eligible.length && (
          <p className='text-muted-foreground text-xs'>
            {t(
              'Models without complete purchase prices are excluded from bulk calculation.'
            )}
          </p>
        )}
        {state.rows.map((row) => (
          <ChannelSellingPriceRow
            key={row.id}
            {...row}
            group={state.group}
            onChange={state.setDraft}
            onReset={() => state.clearDraft(row.id)}
          />
        ))}
        <div className='flex flex-wrap items-center justify-between gap-3 border-t pt-4'>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Preview only until you save. Changing the group shows that group’s actual prices.'
            )}
          </p>
          <Button type='button' disabled={!state.canSave} onClick={state.save}>
            {state.saving
              ? t('Saving selling prices…')
              : t('Save selling prices ({{count}})', { count: state.pending })}
          </Button>
        </div>
      </fieldset>
      {state.results && (
        <p role='status' className='text-sm'>
          {t(
            '{{success}} saved, {{failed}} failed. Failed drafts are retained.',
            {
              success: state.results.filter((result) => result.snapshot).length,
              failed: state.results.filter((result) => result.error).length,
            }
          )}
        </p>
      )}
    </section>
  )
}
