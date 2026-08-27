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
// ----------------------------------------------------------------------------
// Editable cells of the pricing workbench: sale price inputs with live margin,
// target margin with suggestion, and purchase-price fill for rows whose
// upstream cost is unknown.
// ----------------------------------------------------------------------------

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import { formatPercent, formatUsd } from '../lib/formatters'
import {
  effectiveCost,
  parseEditNumber,
  type RowEdit,
  roundEditable,
  suggestSalePrices,
  type WorkbenchRow,
  workbenchMargin,
} from '../lib/workbench'
import type { PriceCompareChannel } from '../types'

function MarginBadge(props: { margin: number | null }) {
  const { t } = useTranslation()
  if (props.margin === null) {
    return (
      <span className='bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs'>
        {t('Cost unknown')}
      </span>
    )
  }
  let className = 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
  if (props.margin < 0) {
    className = 'bg-destructive/10 text-destructive'
  } else if (props.margin < 15) {
    className = 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
  }
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs tabular-nums ${className}`}>
      {formatPercent(props.margin)}
    </span>
  )
}

export function WorkbenchSaleCell(props: {
  row: WorkbenchRow
  edit: RowEdit | undefined
  onEdit: (patch: Partial<RowEdit>) => void
}) {
  const { t } = useTranslation()
  const { row, edit } = props

  if (row.usesFixedPrice) {
    return null // caller renders the fixed-price static cell
  }
  if (row.billingMode === 'tiered_expr') {
    return (
      <div className='text-right tabular-nums'>
        <div>
          {formatUsd(row.localInput)} / {formatUsd(row.localOutput)}
        </div>
        <div className='text-muted-foreground text-xs'>
          {t('Tiered by context')}
        </div>
      </div>
    )
  }
  return (
    <div className='space-y-1'>
      <div className='flex items-center justify-end gap-1'>
        <Input
          type='number'
          min={0}
          step='any'
          aria-label={t('Selling price input')}
          value={edit?.saleInput ?? String(row.localInput)}
          onChange={(event) => props.onEdit({ saleInput: event.target.value })}
          className='h-8 w-24 text-right tabular-nums'
        />
        <span className='text-muted-foreground'>/</span>
        <Input
          type='number'
          min={0}
          step='any'
          aria-label={t('Selling price output')}
          value={edit?.saleOutput ?? String(row.localOutput)}
          onChange={(event) => props.onEdit({ saleOutput: event.target.value })}
          className='h-8 w-24 text-right tabular-nums'
        />
      </div>
      <div className='flex justify-end'>
        <MarginBadge margin={workbenchMargin(row, edit)} />
      </div>
    </div>
  )
}

export function WorkbenchTargetCell(props: {
  row: WorkbenchRow
  edit: RowEdit | undefined
  onEdit: (patch: Partial<RowEdit>) => void
}) {
  const { t } = useTranslation()
  const { row, edit } = props

  if (row.usesFixedPrice || row.billingMode === 'tiered_expr') {
    return <span className='text-muted-foreground'>—</span>
  }
  const cost = effectiveCost(row, edit)
  const target = parseEditNumber(edit?.targetMargin)
  const suggestion =
    cost && target !== null ? suggestSalePrices(cost, target, 0) : null
  return (
    <div className='space-y-1'>
      <div className='flex items-center justify-end gap-1'>
        <Input
          type='number'
          min={0}
          max={95}
          step={1}
          aria-label={t('Target margin')}
          placeholder='—'
          value={edit?.targetMargin ?? ''}
          onChange={(event) =>
            props.onEdit({ targetMargin: event.target.value })
          }
          className='h-8 w-20 text-right tabular-nums'
        />
        <span className='text-muted-foreground text-xs'>%</span>
      </div>
      {suggestion ? (
        <div className='flex items-center justify-end gap-1.5 text-xs tabular-nums'>
          <span className='text-muted-foreground'>
            {formatUsd(suggestion.saleInput)} /{' '}
            {formatUsd(suggestion.saleOutput)}
          </span>
          <Button
            size='xs'
            variant='outline'
            onClick={() =>
              props.onEdit({
                saleInput: roundEditable(suggestion.saleInput),
                saleOutput: roundEditable(suggestion.saleOutput),
              })
            }
          >
            {t('Adopt suggestion')}
          </Button>
        </div>
      ) : (
        <div className='text-muted-foreground text-right text-xs'>—</div>
      )}
    </div>
  )
}

// Purchase-price cell for rows whose upstream cost is unknown: apply the
// detected upstream price in one click, or enter the four price legs manually.
export function WorkbenchCostFillCell(props: {
  channel: PriceCompareChannel
  edit: RowEdit | undefined
  onEdit: (patch: Partial<RowEdit>) => void
  onClearCost: () => void
}) {
  const { t } = useTranslation()
  const { edit, channel } = props
  const [manualOpen, setManualOpen] = useState(false)
  const [manual, setManual] = useState({
    input: '',
    output: '',
    cacheRead: '',
    cacheWrite: '',
  })

  if (edit?.cost) {
    return (
      <div className='text-right text-xs tabular-nums'>
        <div className='text-emerald-600 dark:text-emerald-400'>
          {formatUsd(edit.cost.input)} / {formatUsd(edit.cost.output)}
        </div>
        <div className='text-emerald-600 dark:text-emerald-400'>
          {t('Cache Read')} / {t('Cache Write')}:{' '}
          {formatUsd(edit.cost.cacheRead)} / {formatUsd(edit.cost.cacheWrite)}
        </div>
        <div className='text-muted-foreground'>
          {edit.cost.via === 'detected'
            ? t('Detected price')
            : t('Manual entry')}{' '}
          · {t('Staged')}
          <button
            type='button'
            className='text-muted-foreground hover:text-foreground ml-1 underline'
            onClick={props.onClearCost}
          >
            {t('Undo')}
          </button>
        </div>
      </div>
    )
  }

  const detectedUsable =
    channel.detected_available && channel.detected_input > 0

  return (
    <div className='space-y-1 text-right'>
      <div className='flex flex-wrap justify-end gap-1'>
        {detectedUsable ? (
          <Button
            size='xs'
            variant='outline'
            onClick={() =>
              props.onEdit({
                cost: {
                  input: channel.detected_input,
                  output: channel.detected_output,
                  cacheRead: channel.detected_cache_read,
                  cacheWrite: channel.detected_cache_write,
                  via: 'detected',
                },
              })
            }
          >
            {t('Fill from detected price')}
          </Button>
        ) : (
          <span className='text-destructive text-xs'>
            {t('No detected price for this upstream')}
          </span>
        )}
        <Button
          size='xs'
          variant='ghost'
          onClick={() => setManualOpen((open) => !open)}
        >
          {t('Enter purchase price manually')}
        </Button>
      </div>
      {detectedUsable ? (
        <div className='text-muted-foreground text-xs tabular-nums'>
          {t('Detected')}: {formatUsd(channel.detected_input)} /{' '}
          {formatUsd(channel.detected_output)}
        </div>
      ) : null}
      {manualOpen ? (
        <div className='space-y-1'>
          <div className='flex justify-end gap-1'>
            <Input
              type='number'
              min={0}
              step='any'
              placeholder={t('Input')}
              aria-label={t('Purchase price input')}
              value={manual.input}
              onChange={(e) => setManual({ ...manual, input: e.target.value })}
              className='h-7 w-20 text-right text-xs tabular-nums'
            />
            <Input
              type='number'
              min={0}
              step='any'
              placeholder={t('Output')}
              aria-label={t('Purchase price output')}
              value={manual.output}
              onChange={(e) => setManual({ ...manual, output: e.target.value })}
              className='h-7 w-20 text-right text-xs tabular-nums'
            />
          </div>
          <div className='flex justify-end gap-1'>
            <Input
              type='number'
              min={0}
              step='any'
              placeholder={t('Cache Read')}
              aria-label={t('Purchase cache read')}
              value={manual.cacheRead}
              onChange={(e) =>
                setManual({ ...manual, cacheRead: e.target.value })
              }
              className='h-7 w-20 text-right text-xs tabular-nums'
            />
            <Input
              type='number'
              min={0}
              step='any'
              placeholder={t('Cache Write')}
              aria-label={t('Purchase cache write')}
              value={manual.cacheWrite}
              onChange={(e) =>
                setManual({ ...manual, cacheWrite: e.target.value })
              }
              className='h-7 w-20 text-right text-xs tabular-nums'
            />
          </div>
          <div className='flex items-center justify-end gap-1'>
            <span className='text-muted-foreground text-xs'>
              {t('Cache legs optional, empty means 0')}
            </span>
            <Button
              size='xs'
              variant='outline'
              disabled={
                parseEditNumber(manual.input) === null ||
                parseEditNumber(manual.output) === null
              }
              onClick={() => {
                props.onEdit({
                  cost: {
                    input: parseEditNumber(manual.input) ?? 0,
                    output: parseEditNumber(manual.output) ?? 0,
                    cacheRead: parseEditNumber(manual.cacheRead) ?? 0,
                    cacheWrite: parseEditNumber(manual.cacheWrite) ?? 0,
                    via: 'manual',
                  },
                })
                setManualOpen(false)
              }}
            >
              {t('Apply')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
