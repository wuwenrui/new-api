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
import { Models } from '@opencode-ai/models'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { resolveModelsDevProbeModel } from '@/features/channels/lib/sub2api-onboard'
import {
  getSystemOptionsForModel,
  updatePricingOptions,
} from '@/features/system-settings/api'

import { formatUsd } from '../lib/formatters'
import {
  buildOfficialSyncRequest,
  buildSyncRequest,
  computeOfficialSyncPlan,
  computeSyncRatios,
  defaultTargetMarkupPercent,
  officialTokenPrices,
  parseCompletionRatioMeta,
  parseTargetMarkup,
  parseNumberRecord,
  resolveSyncBasis,
  shouldUseOfficialPricing,
} from '../lib/price-sync'
import type { PriceCompareChannel } from '../types'

const DEFAULT_MARKUP_INPUT = '30'

export function PriceSyncDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  modelName: string
  channel: PriceCompareChannel | null
  group: string
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [markupInput, setMarkupInput] = useState(DEFAULT_MARKUP_INPUT)
  // 目标加价率默认值：每个打开周期只在定价数据就绪后应用一次，
  // 用户在数据加载完成前输入则不再覆盖。
  const [markupUserEdited, setMarkupUserEdited] = useState(false)
  const [markupDefaulted, setMarkupDefaulted] = useState(false)
  const basis = props.channel ? resolveSyncBasis(props.channel) : null
  const usesOfficialPricing = props.channel
    ? shouldUseOfficialPricing(props.channel, basis)
    : false
  const upstreamMultiplier = props.channel?.upstream_price_multiplier ?? 1

  const markupTargetKey = `${props.modelName}|${props.channel?.channel_id ?? 'none'}`

  useEffect(() => {
    if (!props.open) return
    setMarkupInput(DEFAULT_MARKUP_INPUT)
    setMarkupUserEdited(false)
    setMarkupDefaulted(false)
  }, [props.open, markupTargetKey])

  const officialModelQuery = useQuery({
    queryKey: [
      'models-dev-official-price',
      props.channel?.upstream_model,
      props.channel?.upstream_group,
      upstreamMultiplier,
    ],
    queryFn: async () =>
      resolveModelsDevProbeModel(
        await Models.make().providers(),
        props.channel?.upstream_model ?? props.modelName,
        props.channel?.upstream_group ?? '',
        upstreamMultiplier
      ),
    enabled: props.open && Boolean(props.channel) && usesOfficialPricing,
    staleTime: 60 * 60 * 1000,
  })

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

  const completionMeta =
    optionState.completionMeta[props.modelName] ??
    optionState.completionMeta[optionState.pricingModelKey]
  const groupRatioValid =
    Number.isFinite(optionState.groupRatio) && optionState.groupRatio > 0
  const quotaPerUnitValid =
    Number.isFinite(optionState.quotaPerUnit) && optionState.quotaPerUnit > 0
  const targetMarkup = parseTargetMarkup(markupInput)
  const ratioPlan =
    !usesOfficialPricing &&
    basis &&
    optionsQuery.isSuccess &&
    groupRatioValid &&
    quotaPerUnitValid &&
    targetMarkup !== null
      ? computeSyncRatios(
          basis,
          targetMarkup,
          optionState.groupRatio,
          completionMeta?.locked ? completionMeta.ratio : undefined,
          optionState.quotaPerUnit
        )
      : null
  const officialResolution = officialModelQuery.data ?? null
  // Effective upstream cost comes from the Models.dev base price times the
  // multiplier; it is independent of the target markup, so an invalid markup
  // must never blank out the displayed official cost.
  const officialCost = useMemo(() => {
    if (!officialResolution) return null
    const pricing = officialResolution.model.models_dev_pricing
    if (!pricing) return null
    return officialTokenPrices(pricing.base, pricing.upstream_multiplier)
  }, [officialResolution])

  // 默认目标加价率取自当前加价率（售价-有效上游成本）/有效上游成本，
  // 取输入/输出中较低者；只在数据就绪后应用一次，不覆盖用户编辑。
  useEffect(() => {
    if (!props.open || markupUserEdited || markupDefaulted) return
    const channel = props.channel
    if (!channel || channel.uses_fixed_price) return
    const markupInputs = {
      sellingInput: channel.local_input,
      sellingOutput: channel.local_output,
    }
    let target: number | null = null
    if (usesOfficialPricing) {
      const pricing = officialResolution?.model.models_dev_pricing
      if (!pricing) return
      const cost = officialTokenPrices(
        pricing.base,
        pricing.upstream_multiplier
      )
      target = defaultTargetMarkupPercent({
        ...markupInputs,
        costInput: cost.input,
        costOutput: cost.output,
      })
    } else if (basis) {
      target = defaultTargetMarkupPercent({
        ...markupInputs,
        costInput: basis.input,
        costOutput: basis.output,
      })
    } else {
      return
    }
    if (target !== null) {
      setMarkupInput(String(target))
      setMarkupDefaulted(true)
    }
  }, [
    props.open,
    props.channel,
    markupUserEdited,
    markupDefaulted,
    usesOfficialPricing,
    basis,
    officialResolution,
  ])
  const officialPlan =
    usesOfficialPricing &&
    officialResolution &&
    optionsQuery.isSuccess &&
    groupRatioValid &&
    targetMarkup !== null
      ? computeOfficialSyncPlan(
          officialResolution.model,
          targetMarkup,
          optionState.groupRatio
        )
      : null
  const previewPlan = officialPlan ?? ratioPlan
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
      if (!ratioPlan && !officialPlan) {
        throw new Error(t('Markup must be at least 0'))
      }
      if (!props.channel) {
        throw new Error(t('Channel pricing is unavailable'))
      }
      let request
      if (officialPlan && officialResolution) {
        request = buildOfficialSyncRequest(
          props.modelName,
          props.channel.channel_id,
          officialResolution.providerId,
          officialPlan
        )
      } else if (ratioPlan) {
        request = buildSyncRequest(props.modelName, ratioPlan)
      } else {
        throw new Error(t('Markup must be at least 0'))
      }
      const res = await updatePricingOptions(request)
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
    (!ratioPlan && !officialPlan) ||
    hasSharedFixedPrice ||
    syncMutation.isPending ||
    !optionsQuery.isSuccess ||
    (usesOfficialPricing && officialModelQuery.isLoading)

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

        {optionsQuery.isLoading ||
        (usesOfficialPricing && officialModelQuery.isLoading) ? (
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

        {!usesOfficialPricing && basis ? (
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

        {usesOfficialPricing && officialResolution ? (
          <div className='space-y-1 rounded-md border p-3 text-sm tabular-nums'>
            <div className='text-muted-foreground text-xs'>
              {t('Using official model price')} ·{' '}
              {officialResolution.providerName}
            </div>
            <div>
              {t('Cost')}: {formatUsd(officialCost?.input ?? 0)} /{' '}
              {formatUsd(officialCost?.output ?? 0)}
            </div>
            <div className='text-muted-foreground text-xs'>
              {t('Cache Read')} / {t('Cache Write')}:{' '}
              {formatUsd(officialCost?.cacheRead ?? 0)} /{' '}
              {formatUsd(officialCost?.cacheWrite ?? 0)}
            </div>
          </div>
        ) : null}

        {usesOfficialPricing &&
        officialModelQuery.isSuccess &&
        !officialResolution ? (
          <Alert variant='destructive'>
            <AlertTitle>
              {t('Official model price could not be loaded')}
            </AlertTitle>
            <AlertDescription>
              {t(
                'Official pricing is unavailable for this model and provider.'
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className='space-y-2'>
          <Label htmlFor='price-sync-markup'>{t('Target markup (%)')}</Label>
          <Input
            id='price-sync-markup'
            type='number'
            min={0}
            step={0.01}
            value={markupInput}
            onChange={(event) => {
              setMarkupUserEdited(true)
              setMarkupInput(event.target.value)
            }}
          />
          {!groupRatioValid && optionsQuery.isSuccess ? (
            <p className='text-destructive text-xs'>
              {t('Pricing group ratio must be greater than 0')}
            </p>
          ) : null}
          {!usesOfficialPricing &&
          !quotaPerUnitValid &&
          optionsQuery.isSuccess ? (
            <p className='text-destructive text-xs'>
              {t('Pricing quota scale must be greater than 0')}
            </p>
          ) : null}
          {!previewPlan &&
          (basis || officialResolution) &&
          groupRatioValid &&
          (usesOfficialPricing || quotaPerUnitValid) ? (
            <p className='text-destructive text-xs'>
              {t('Markup must be at least 0')}
            </p>
          ) : null}
        </div>

        {previewPlan && props.channel ? (
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
                {formatUsd(previewPlan.sellInput)} /{' '}
                {formatUsd(previewPlan.sellOutput)}
              </span>
            </div>
            {officialPlan ? (
              <div className='text-muted-foreground space-y-1 border-t pt-2 text-xs'>
                <div className='text-foreground font-medium'>
                  {t('Context pricing tiers')}
                </div>
                <div className='flex justify-between gap-3'>
                  <span>{t('Base tier')}</span>
                  <span>
                    {formatUsd(officialPlan.sellInput)} /{' '}
                    {formatUsd(officialPlan.sellOutput)}
                  </span>
                </div>
                {officialPlan.tiers.map((tier) => (
                  <div
                    className='flex justify-between gap-3'
                    key={tier.contextThreshold}
                  >
                    <span>
                      {t('Context at least {{tokens}} tokens', {
                        tokens: tier.contextThreshold.toLocaleString(),
                      })}
                    </span>
                    <span>
                      {formatUsd(tier.sellInput)} / {formatUsd(tier.sellOutput)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {!officialPlan && ratioPlan ? (
              <div className='text-muted-foreground space-y-1 border-t pt-2 text-xs'>
                <div>
                  {t('Model ratio')}: {ratioPlan.modelRatio}
                </div>
                <div>
                  {t('Completion ratio')}: {ratioPlan.completionRatio}
                  {ratioPlan.completionRatioLocked ? ` (${t('Locked')})` : ''}
                </div>
                <div>
                  {t('Prompt cache ratio')}: {ratioPlan.cacheRatio}
                </div>
                <div>
                  {t('Create cache ratio')}: {ratioPlan.createCacheRatio}
                </div>
              </div>
            ) : null}
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
