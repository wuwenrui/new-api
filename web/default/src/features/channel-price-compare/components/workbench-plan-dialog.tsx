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
// Review-and-execute dialog of the pricing workbench. Lists every staged
// change, skips rows the ratio endpoint cannot write, then executes
// sequentially with a per-model drift check and read-back through the
// channel price compare query invalidation.
// ----------------------------------------------------------------------------

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Spinner } from '@/components/ui/spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getChannel, updateChannel } from '@/features/channels/api'
import {
  getSystemOptionsForModel,
  updatePricingOptions,
} from '@/features/system-settings/api'
import type { PricingOptionsUpdateRequest } from '@/features/system-settings/types'

import { formatPercent, formatUsd } from '../lib/formatters'
import { parseCompletionRatioMeta, parseNumberRecord } from '../lib/price-sync'
import {
  buildRatioSyncRequest,
  effectiveCost,
  isPriceDirty,
  isRowDirty,
  mergeModelPriceIntoSettings,
  parseEditNumber,
  type RowEdit,
  unwriteableReason,
  type WorkbenchRow,
  workbenchMargin,
} from '../lib/workbench'

type PlanItem = { row: WorkbenchRow; edit: RowEdit }
type SkipItem = { row: WorkbenchRow; reason: string }

type ItemResult = {
  key: string
  status: 'ok' | 'failed' | 'rejected'
  detail: string
}

const RESULT_TEXT_CLASS: Record<ItemResult['status'], string> = {
  ok: 'text-xs text-emerald-600 dark:text-emerald-400',
  rejected: 'text-xs text-amber-600 dark:text-amber-400',
  failed: 'text-destructive text-xs',
}
const RESULT_ICON: Record<ItemResult['status'], string> = {
  ok: '✓ ',
  rejected: '⚠ ',
  failed: '✗ ',
}

function planItems(
  rows: WorkbenchRow[],
  edits: Record<string, RowEdit>,
  t: (key: string) => string
): { items: PlanItem[]; skips: SkipItem[] } {
  const items: PlanItem[] = []
  const skips: SkipItem[] = []
  for (const row of rows) {
    const edit = edits[row.key]
    if (!isRowDirty(row, edit)) continue
    const unwriteable = unwriteableReason(row)
    if (unwriteable === 'fixed') {
      skips.push({
        row,
        reason: t('Fixed per-request price models are not supported here'),
      })
      continue
    }
    if (unwriteable === 'tiered') {
      skips.push({
        row,
        reason: t(
          'Tiered pricing models must use the sync dialog to avoid overwriting tier expressions'
        ),
      })
      continue
    }
    if (isPriceDirty(row, edit)) {
      const si = parseEditNumber(edit?.saleInput) ?? row.localInput
      const so = parseEditNumber(edit?.saleOutput) ?? row.localOutput
      if (!(si > 0) || !(so >= 0)) {
        skips.push({
          row,
          reason: t('Selling price must be a positive number'),
        })
        continue
      }
    }
    items.push({ row, edit: edit ?? {} })
  }
  return { items, skips }
}

export function WorkbenchPlanDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: WorkbenchRow[]
  edits: Record<string, RowEdit>
  group: string
  onExecuted: (keys: string[]) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [confirmed, setConfirmed] = useState(false)
  const [results, setResults] = useState<ItemResult[]>([])

  const { items, skips } = useMemo(
    () => planItems(props.rows, props.edits, t),
    [props.rows, props.edits, t]
  )

  const executeMutation = useMutation({
    mutationFn: async () => {
      const outcomes: ItemResult[] = []
      for (const { row, edit } of items) {
        const label = `${row.modelName} · ${row.channelName}`
        try {
          // Step 1: staged purchase price → channel settings.model_prices
          // (the channel update path used by the channel edit drawer).
          let costApplied = false
          if (edit.cost) {
            const channelRes = await getChannel(row.channelId)
            if (!channelRes.success || !channelRes.data) {
              throw new Error(
                channelRes.message || t('Purchase price write failed')
              )
            }
            const settings = mergeModelPriceIntoSettings(
              channelRes.data.settings ?? '{}',
              row.modelName,
              edit.cost
            )
            // PUT /api/channel/ rejects payloads carrying `status`
            // (it has a dedicated endpoint), so strip it before echoing
            // the fetched channel back with the merged settings.
            const { status: ignoredStatus, ...channelBody } = channelRes.data
            void ignoredStatus
            const putChannel = await updateChannel(row.channelId, {
              ...channelBody,
              settings,
            })
            if (!putChannel.success) {
              throw new Error(
                putChannel.message || t('Purchase price write failed')
              )
            }
            costApplied = true
          }
          // Step 2: staged selling price → site pricing options, guarded by
          // a drift check against the freshly read online ratios.
          if (!isPriceDirty(row, edit)) {
            outcomes.push({ key: row.key, status: 'ok', detail: label })
            continue
          }
          const optionsRes = await getSystemOptionsForModel(row.modelName)
          const options = optionsRes.data ?? []
          const read = (key: string) =>
            options.find((option) => option.key === key)?.value
          const pricingKey = read('PricingModelKey') || row.modelName
          const completionMeta = parseCompletionRatioMeta(
            read('CompletionRatioMeta')
          )
          let locked: number | undefined
          if (completionMeta[row.modelName]?.locked === true) {
            locked = completionMeta[row.modelName].ratio
          } else if (completionMeta[pricingKey]?.locked === true) {
            locked = completionMeta[pricingKey].ratio
          }
          const built = buildRatioSyncRequest(row, edit, {
            groupRatio: parseNumberRecord(read('GroupRatio'))[props.group] ?? 1,
            modelRatio: parseNumberRecord(read('ModelRatio'))[pricingKey],
            completionRatio: parseNumberRecord(read('CompletionRatio'))[
              pricingKey
            ],
            cacheRatio: parseNumberRecord(read('CacheRatio'))[pricingKey],
            createCacheRatio: parseNumberRecord(read('CreateCacheRatio'))[
              pricingKey
            ],
            lockedCompletionRatio: locked,
            hasFixedPrice:
              parseNumberRecord(read('ModelPrice'))[pricingKey] !== undefined,
          })
          if (!built.ok) {
            const reasonKey = {
              'fixed-price': 'Skipped: the model has a fixed per-request price',
              'missing-current-ratio':
                'Skipped: current online ModelRatio not found',
              drift: 'Skipped: online price drifted from the staged base',
              'locked-completion-conflict':
                'Skipped: staged output price conflicts with the locked completion ratio',
              'invalid-sale-price': 'Skipped: invalid staged selling price',
            }[built.reason]
            outcomes.push({
              key: row.key,
              status: 'rejected',
              detail: `${label} — ${t(reasonKey)}${built.detail ? ` (${built.detail})` : ''}`,
            })
            continue
          }
          const res = await updatePricingOptions(
            built.request as PricingOptionsUpdateRequest
          )
          if (!res.success) {
            outcomes.push({
              key: row.key,
              status: 'failed',
              detail: `${label} — ${res.message || t('Write failed')}`,
            })
            continue
          }
          outcomes.push({
            key: row.key,
            status: 'ok',
            detail: costApplied
              ? `${label} (${t('Purchase price updated')})`
              : label,
          })
        } catch (error) {
          outcomes.push({
            key: row.key,
            status: 'failed',
            detail: `${label} — ${error instanceof Error ? error.message : t('Write failed')}`,
          })
        }
      }
      return outcomes
    },
    onSuccess: (outcomes) => {
      setResults(outcomes)
      const okKeys = outcomes
        .filter((outcome) => outcome.status === 'ok')
        .map((outcome) => outcome.key)
      const failed = outcomes.length - okKeys.length
      if (okKeys.length > 0) {
        toast.success(t('Price changes applied'))
        queryClient.invalidateQueries({ queryKey: ['channel-price-compare'] })
        queryClient.invalidateQueries({ queryKey: ['system-options'] })
        props.onExecuted(okKeys)
      }
      if (failed > 0) {
        toast.error(t('Some changes were skipped or failed'))
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || t('Write failed'))
    },
  })

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setConfirmed(false)
      setResults([])
      executeMutation.reset()
    }
    props.onOpenChange(open)
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={handleOpenChange}
      title={t('Price change plan')}
      description={t(
        'Review every staged change before writing to the site pricing options.'
      )}
      footer={
        <>
          <label className='mr-auto flex items-center gap-2 text-sm'>
            <Checkbox
              checked={confirmed}
              onCheckedChange={(checked) => setConfirmed(checked === true)}
            />
            {t('I have reviewed all changes above')}
          </label>
          <Button variant='outline' onClick={() => handleOpenChange(false)}>
            {t('Close')}
          </Button>
          <Button
            variant='destructive'
            disabled={
              !confirmed || items.length === 0 || executeMutation.isPending
            }
            onClick={() => executeMutation.mutate()}
          >
            {executeMutation.isPending ? <Spinner /> : null}
            {t('Execute changes')}
          </Button>
        </>
      }
    >
      <div className='space-y-4'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Model')}</TableHead>
              <TableHead>{t('Channel')}</TableHead>
              <TableHead className='text-right'>{t('Current price')}</TableHead>
              <TableHead className='text-right'>{t('New price')}</TableHead>
              <TableHead className='text-right'>{t('New margin')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map(({ row, edit }) => {
              const priceDirty = isPriceDirty(row, edit)
              const cost = effectiveCost(row, edit)
              const margin = workbenchMargin(row, edit)
              return (
                <TableRow key={row.key}>
                  <TableCell className='font-medium'>
                    {row.modelName}
                    {edit.cost ? (
                      <div className='text-xs font-normal text-emerald-600 dark:text-emerald-400'>
                        {t('Purchase price to fill')}:{' '}
                        {formatUsd(edit.cost.input)} /{' '}
                        {formatUsd(edit.cost.output)} (
                        {edit.cost.via === 'detected'
                          ? t('Detected price')
                          : t('Manual entry')}
                        )
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>{row.channelName}</TableCell>
                  <TableCell className='text-right tabular-nums'>
                    {formatUsd(row.localInput)} / {formatUsd(row.localOutput)}
                  </TableCell>
                  {priceDirty ? (
                    <>
                      <TableCell className='text-primary text-right tabular-nums'>
                        {formatUsd(
                          parseEditNumber(edit.saleInput) ?? row.localInput
                        )}{' '}
                        /{' '}
                        {formatUsd(
                          parseEditNumber(edit.saleOutput) ?? row.localOutput
                        )}
                      </TableCell>
                      <TableCell className='text-right tabular-nums'>
                        {margin !== null && cost ? formatPercent(margin) : '—'}
                      </TableCell>
                    </>
                  ) : (
                    <TableCell
                      className='text-muted-foreground text-right'
                      colSpan={2}
                    >
                      {t('Price unchanged')}
                    </TableCell>
                  )}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>

        {skips.length > 0 ? (
          <div className='space-y-1'>
            <div className='text-sm font-medium'>{t('Skipped rows')}</div>
            {skips.map(({ row, reason }) => (
              <div
                key={row.key}
                className='flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400'
              >
                <Badge variant='outline'>{row.modelName}</Badge>
                <span>{row.channelName}</span>—<span>{reason}</span>
              </div>
            ))}
          </div>
        ) : null}

        {results.length > 0 ? (
          <div className='space-y-1'>
            <div className='text-sm font-medium'>{t('Execution results')}</div>
            {results.map((result) => (
              <div
                key={result.key}
                className={RESULT_TEXT_CLASS[result.status]}
              >
                {RESULT_ICON[result.status]}
                {result.detail}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
