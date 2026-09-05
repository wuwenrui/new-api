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
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import {
  grossMargin,
  SALE_FIELDS,
  scalePrices,
  type SaleDraft,
  type SaleSnapshot,
  type TokenPrices,
} from '../lib/channel-sale-pricing'

type Props = {
  model: string
  snapshot?: SaleSnapshot
  draft?: SaleDraft
  cost: TokenPrices | null
  proposed: TokenPrices | null
  group: string
  error?: string
  validation: string
  loading: boolean
  onChange: (
    snapshot: SaleSnapshot,
    patch: Pick<SaleDraft, 'margin' | 'manual'>
  ) => void
  onReset: () => void
}

export function ChannelSellingPriceRow(props: Props) {
  const { t } = useTranslation()
  const snapshot = props.snapshot
  const labels = {
    input: t('Input'),
    output: t('Output'),
    cache_read: t('Cache Read'),
    cache_write: t('Cache Write'),
  }
  const statusLabels = {
    missing: t('Not priced'),
    ratio: t('Priced'),
    fixed: t('Per-request pricing'),
    tiered: t('Tiered pricing'),
    incomplete: t('Incomplete pricing'),
  }
  const ratio = snapshot?.groups[props.group]
  const validGroup = ratio !== undefined && Number.isFinite(ratio) && ratio > 0
  const current =
    snapshot?.prices && validGroup ? scalePrices(snapshot.prices, ratio) : null
  const shown = props.draft ? props.proposed : current
  const editable =
    snapshot &&
    snapshot.status !== 'fixed' &&
    snapshot.status !== 'tiered' &&
    validGroup
  const money = (value: number | undefined) =>
    value === undefined ? '—' : `$${Number(value.toPrecision(10))}`
  return (
    <article
      aria-label={props.model}
      className='border-border/60 space-y-4 rounded-lg border p-4'
    >
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='min-w-0 space-y-1'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='font-mono text-sm font-medium break-all'>
              {props.model}
            </span>
            {snapshot && (
              <span className='bg-muted rounded px-2 py-0.5 text-xs'>
                {statusLabels[snapshot.status]}
              </span>
            )}
          </div>
          {snapshot && snapshot.key !== props.model && (
            <p className='text-muted-foreground text-xs'>
              {t('Shared pricing rule: {{model}}', { model: snapshot.key })}
            </p>
          )}
        </div>
        {editable && (
          <div className='flex items-end gap-2'>
            <label className='space-y-1 text-xs'>
              {t('Target gross margin (%)')}
              <Input
                type='number'
                min={0}
                max={99.99}
                step='any'
                className='h-8 w-28'
                aria-label={`${props.model} ${t('Target gross margin (%)')}`}
                value={props.draft?.margin ?? ''}
                disabled={!props.cost || props.loading}
                placeholder='20'
                onChange={(event) =>
                  props.onChange(snapshot, { margin: event.target.value })
                }
              />
            </label>
            {props.draft && (
              <Button
                type='button'
                size='sm'
                variant='ghost'
                onClick={props.onReset}
              >
                {t('Reset preview')}
              </Button>
            )}
          </div>
        )}
      </div>
      {props.loading && (
        <p role='status' className='text-muted-foreground text-xs'>
          {t('Loading selling prices…')}
        </p>
      )}
      {props.error && (
        <p role='alert' className='text-destructive text-xs'>
          {t(props.error)}
        </p>
      )}
      {snapshot && !validGroup && (
        <p role='alert' className='text-destructive text-xs'>
          {t(
            'This group has no positive pricing multiplier. Select another group.'
          )}
        </p>
      )}
      {editable && (
        <>
          {!props.cost && (
            <p className='text-muted-foreground text-xs'>
              {t(
                'Complete purchase prices above to calculate gross margins. You can still enter selling prices directly.'
              )}
            </p>
          )}
          <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4'>
            {SALE_FIELDS.map((field) => {
              const margin =
                shown && props.cost
                  ? grossMargin(shown[field], props.cost[field])
                  : null
              const value =
                props.draft?.manual?.[field] ??
                (shown ? Number(shown[field].toPrecision(12)) : '')
              return (
                <div key={field} className='space-y-2'>
                  <label className='block space-y-2 text-xs font-medium'>
                    {labels[field]}
                    <Input
                      aria-label={`${props.model} ${labels[field]} ${t('selling price')}`}
                      type='number'
                      min={0}
                      step='any'
                      value={value}
                      disabled={props.loading}
                      onChange={(event) => {
                        const manual = Object.fromEntries(
                          SALE_FIELDS.map((key) => [
                            key,
                            props.draft?.manual?.[key] ??
                              String(
                                shown ? Number(shown[key].toPrecision(12)) : ''
                              ),
                          ])
                        ) as Record<typeof field, string>
                        props.onChange(snapshot, {
                          margin: '',
                          manual: { ...manual, [field]: event.target.value },
                        })
                      }}
                    />
                  </label>
                  <div className='text-muted-foreground space-y-1 text-xs tabular-nums'>
                    <p>
                      {t('Purchase')}: {money(props.cost?.[field])}
                    </p>
                    <p>
                      {t('Current selling price')}: {money(current?.[field])}
                    </p>
                    <p
                      className={
                        margin !== null && margin < 0 ? 'text-destructive' : ''
                      }
                    >
                      {t('Gross margin')}:{' '}
                      {margin === null ? '—' : `${margin.toFixed(2)}%`}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
          {snapshot.lockedCompletion !== null && (
            <p className='text-muted-foreground text-xs'>
              {t(
                'The system locks output to {{ratio}} times the input price.',
                { ratio: snapshot.lockedCompletion }
              )}
            </p>
          )}
          {props.validation && (
            <p role='alert' className='text-destructive text-xs'>
              {t(props.validation)}
            </p>
          )}
        </>
      )}
      {snapshot && !editable && validGroup && (
        <p className='text-muted-foreground text-sm'>
          {snapshot.status === 'fixed' && (
            <span>
              {t('Current selling price')}:{' '}
              {money((snapshot.fixedPrice ?? 0) * ratio)} / {t('request')}.{' '}
            </span>
          )}
          {t('Manage per-request and tiered prices in model pricing settings.')}{' '}
          <a
            className='text-primary underline'
            href='/system-settings/models'
            target='_blank'
            rel='noreferrer'
          >
            {t('Open model pricing')}
          </a>
        </p>
      )}
    </article>
  )
}
