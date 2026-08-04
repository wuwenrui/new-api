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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import {
  getSystemOptionsForModel,
  updatePricingOptions,
} from '@/features/system-settings/api'

import { formatUsd } from '../lib/formatters'
import {
  buildSyncRequest,
  computeSyncRatios,
  MAX_TARGET_MARGIN_PERCENT,
  parseCompletionRatioMeta,
  parseTargetMargin,
  parseNumberRecord,
  resolveSyncBasis,
} from '../lib/price-sync'
import type { PriceCompareChannel } from '../types'

const DEFAULT_MARGIN_INPUT = '30'

export function PriceSyncDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  modelName: string
  channel: PriceCompareChannel | null
  group: string
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [marginInput, setMarginInput] = useState(DEFAULT_MARGIN_INPUT)

  const optionsQuery = useQuery({
    queryKey: ['system-options', props.modelName],
    queryFn: () => getSystemOptionsForModel(props.modelName),
    enabled: props.open,
  })

  const optionState = useMemo(() => {
    const options = optionsQuery.data?.data ?? []
    const read = (key: string) =>
      options.find((option) => option.key === key)?.value
    const pricingModelKey = read('PricingModelKey') || props.modelName
    return {
      groupRatio: parseNumberRecord(read('GroupRatio'))[props.group] ?? 1,
      quotaPerUnit: Number(read('QuotaPerUnit')),
      completionMeta: parseCompletionRatioMeta(read('CompletionRatioMeta')),
      modelPrices: parseNumberRecord(read('ModelPrice')),
      pricingModelKey,
    }
  }, [optionsQuery.data, props.group, props.modelName])

  const basis = props.channel ? resolveSyncBasis(props.channel) : null
  const completionMeta =
    optionState.completionMeta[props.modelName] ??
    optionState.completionMeta[optionState.pricingModelKey]
  const groupRatioValid =
    Number.isFinite(optionState.groupRatio) && optionState.groupRatio > 0
  const quotaPerUnitValid =
    Number.isFinite(optionState.quotaPerUnit) && optionState.quotaPerUnit > 0
  const targetMargin = parseTargetMargin(marginInput)
  const plan =
    basis &&
    optionsQuery.isSuccess &&
    groupRatioValid &&
    quotaPerUnitValid &&
    targetMargin !== null
      ? computeSyncRatios(
          basis,
          targetMargin,
          optionState.groupRatio,
          completionMeta?.locked ? completionMeta.ratio : undefined,
          optionState.quotaPerUnit
        )
      : null
  const hasFixedPrice =
    optionsQuery.isSuccess &&
    optionState.modelPrices[optionState.pricingModelKey] !== undefined
  const hasSharedFixedPrice =
    hasFixedPrice && optionState.pricingModelKey === '*-openai-compact'

  const syncMutation = useMutation({
    mutationFn: async () => {
      if (!optionsQuery.isSuccess) {
        throw new Error(t('Pricing options could not be loaded'))
      }
      if (hasSharedFixedPrice) {
        throw new Error(
          t('Shared fixed price rules cannot be synced per model')
        )
      }
      if (!plan) throw new Error(t('Margin must be between 0 and 95'))
      const res = await updatePricingOptions(
        buildSyncRequest(props.modelName, plan)
      )
      if (!res.success) {
        throw new Error(res.message || t('Failed to sync selling price'))
      }
    },
    onSuccess: () => {
      toast.success(t('Selling price synced'))
      queryClient.invalidateQueries({ queryKey: ['channel-price-compare'] })
      queryClient.invalidateQueries({ queryKey: ['system-options'] })
      props.onOpenChange(false)
    },
    onError: (error: Error) => {
      toast.error(error.message || t('Failed to sync selling price'))
    },
  })

  const confirmDisabled =
    !plan ||
    hasSharedFixedPrice ||
    syncMutation.isPending ||
    !optionsQuery.isSuccess

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Sync selling price')}
      description={t(
        'Selling prices apply globally to this model across all channels.'
      )}
      footer={
        <>
          <Button
            variant='outline'
            onClick={() => props.onOpenChange(false)}
            disabled={syncMutation.isPending}
          >
            {t('Cancel')}
          </Button>
          <Button
            onClick={() => syncMutation.mutate()}
            disabled={confirmDisabled}
          >
            {syncMutation.isPending ? <Spinner /> : null}
            {t('Apply selling price')}
          </Button>
        </>
      }
    >
      <div className='space-y-4'>
        <div className='space-y-1 text-sm'>
          <div>
            <span className='text-muted-foreground'>{t('Model')}: </span>
            <span className='font-mono'>{props.modelName}</span>
          </div>
          <div>
            <span className='text-muted-foreground'>{t('Channel')}: </span>
            {props.channel?.channel_name}
          </div>
        </div>

        {optionsQuery.isLoading ? (
          <div className='text-muted-foreground flex items-center gap-2 text-sm'>
            <Spinner />
            {t('Loading pricing options...')}
          </div>
        ) : null}

        {optionsQuery.isError ? (
          <Alert variant='destructive'>
            <AlertTitle>{t('Pricing options could not be loaded')}</AlertTitle>
            <AlertDescription>
              {t('Check the service and try again.')}
            </AlertDescription>
          </Alert>
        ) : null}

        {basis ? (
          <div className='space-y-1 rounded-md border p-3 text-sm tabular-nums'>
            <div className='text-muted-foreground text-xs'>
              {basis.source === 'detected'
                ? t('Using detected upstream price')
                : t('Using manually maintained purchase price')}
            </div>
            <div>
              {t('Cost')}: {formatUsd(basis.input)} / {formatUsd(basis.output)}
            </div>
            <div className='text-muted-foreground text-xs'>
              {t('Cache Read')} / {t('Cache Write')}:{' '}
              {formatUsd(basis.cacheRead)} / {formatUsd(basis.cacheWrite)}
            </div>
          </div>
        ) : null}

        <div className='space-y-2'>
          <Label htmlFor='price-sync-margin'>{t('Target margin (%)')}</Label>
          <Input
            id='price-sync-margin'
            type='number'
            min={0}
            max={MAX_TARGET_MARGIN_PERCENT - 1}
            step={1}
            value={marginInput}
            onChange={(event) => setMarginInput(event.target.value)}
          />
          {!groupRatioValid && optionsQuery.isSuccess ? (
            <p className='text-destructive text-xs'>
              {t('Pricing group ratio must be greater than 0')}
            </p>
          ) : null}
          {!quotaPerUnitValid && optionsQuery.isSuccess ? (
            <p className='text-destructive text-xs'>
              {t('Pricing quota scale must be greater than 0')}
            </p>
          ) : null}
          {!plan && basis && groupRatioValid && quotaPerUnitValid ? (
            <p className='text-destructive text-xs'>
              {t('Margin must be between 0 and 95')}
            </p>
          ) : null}
        </div>

        {plan && props.channel ? (
          <div className='space-y-2 rounded-md border p-3 text-sm tabular-nums'>
            <div className='flex justify-between gap-4'>
              <span className='text-muted-foreground'>
                {t('Current selling price')}
              </span>
              <span>
                {props.channel.uses_fixed_price ? (
                  <>
                    {formatUsd(props.channel.fixed_price)} ·{' '}
                    {t('Per-request (fixed price)')}
                  </>
                ) : (
                  <>
                    {formatUsd(props.channel.local_input)} /{' '}
                    {formatUsd(props.channel.local_output)}
                  </>
                )}
              </span>
            </div>
            <div className='flex justify-between gap-4 font-medium'>
              <span>{t('New selling price (input / output)')}</span>
              <span>
                {formatUsd(plan.sellInput)} / {formatUsd(plan.sellOutput)}
              </span>
            </div>
            <div className='text-muted-foreground space-y-1 border-t pt-2 text-xs'>
              <div>
                {t('Model ratio')}: {plan.modelRatio}
              </div>
              <div>
                {t('Completion ratio')}: {plan.completionRatio}
                {plan.completionRatioLocked ? ` (${t('Locked')})` : ''}
              </div>
              <div>
                {t('Prompt cache ratio')}: {plan.cacheRatio}
              </div>
              <div>
                {t('Create cache ratio')}: {plan.createCacheRatio}
              </div>
            </div>
          </div>
        ) : null}

        {hasFixedPrice ? (
          <Alert variant='destructive'>
            <AlertTitle>
              {t(
                hasSharedFixedPrice
                  ? 'Shared fixed price conflict'
                  : 'Fixed price conflict'
              )}
            </AlertTitle>
            <AlertDescription>
              {t(
                hasSharedFixedPrice
                  ? 'This model inherits a fixed price shared by multiple models. Edit the shared pricing rule before switching billing modes.'
                  : 'This model currently uses fixed per-request pricing. Syncing removes the fixed price and switches it to ratio billing.'
              )}
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
    </Dialog>
  )
}
