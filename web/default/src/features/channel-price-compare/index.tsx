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
import {
  AlertTriangle,
  CircleDollarSign,
  RefreshCw,
  Search,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SectionPageLayout } from '@/components/layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Spinner } from '@/components/ui/spinner'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { getChannelPriceCompare } from './api'
import { ChannelSummaryTable } from './components/channel-summary-table'
import { PriceCompareTable } from './components/price-compare-table'
import { WorkbenchPlanDialog } from './components/workbench-plan-dialog'
import {
  filterPriceCompareModels,
  formatPercent,
  formatUsd,
  summarizeChannelRows,
  summarizePriceCompareModels,
  type ChannelRiskFilter,
} from './lib/formatters'
import {
  type AutotuneScope,
  autotuneRows,
  flattenWorkbenchRows,
  isRowDirty,
  type RowEdit,
  workbenchRowFromChannel,
} from './lib/workbench'

const TARGET_MARGIN_STORAGE_KEY = 'pricing-workbench:target-margin'

const REC_LABEL_KEYS: Record<string, string> = {
  missing_price: 'Add purchase price',
  price_changed: 'Check upstream price change',
  negative_margin: 'Adjust price or stop after review',
  low_margin: 'Review selling price or supplier',
  low_success_rate: 'Lower priority or stop after review',
}

function MetricCard(props: {
  title: string
  value: string
  detail: string
  icon: ReactNode
  tone?: 'normal' | 'risk'
}) {
  return (
    <Card
      className={props.tone === 'risk' ? 'border-destructive/40' : undefined}
    >
      <CardContent className='flex items-start justify-between p-5'>
        <div>
          <div className='text-muted-foreground text-xs font-medium tracking-wide uppercase'>
            {props.title}
          </div>
          <div className='mt-2 text-2xl font-semibold tabular-nums'>
            {props.value}
          </div>
          <div className='text-muted-foreground mt-1 text-xs'>
            {props.detail}
          </div>
        </div>
        <div
          className={
            props.tone === 'risk'
              ? 'bg-destructive/10 text-destructive rounded-lg p-2'
              : 'bg-primary/10 text-primary rounded-lg p-2'
          }
        >
          {props.icon}
        </div>
      </CardContent>
    </Card>
  )
}

export function ChannelPriceCompare() {
  const { t } = useTranslation()
  const user = useAuthStore((state) => state.auth.user)
  const canSyncPrice = user?.role === ROLE.SUPER_ADMIN
  const [group, setGroup] = useState('default')
  const [groupInput, setGroupInput] = useState('default')
  const [modelFilter, setModelFilter] = useState('')
  const [channelFilter, setChannelFilter] = useState('')
  const [riskFilter, setRiskFilter] = useState<ChannelRiskFilter>('all')
  // ---- pricing workbench state (super admin only) ----
  const [edits, setEdits] = useState<Record<string, RowEdit>>({})
  const [planOpen, setPlanOpen] = useState(false)
  const [sortBy, setSortBy] = useState<'margin-asc' | 'profit-desc' | 'name'>(
    'margin-asc'
  )
  const [targetMargin, setTargetMargin] = useState(
    () => localStorage.getItem(TARGET_MARGIN_STORAGE_KEY) ?? '30'
  )
  const [autotuneOpen, setAutotuneOpen] = useState(false)
  const [autotuneScope, setAutotuneScope] = useState<AutotuneScope>('below')
  const [autotuneStep, setAutotuneStep] = useState('0.1')
  const [autotuneMsg, setAutotuneMsg] = useState('')

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['channel-price-compare', group],
    queryFn: () => getChannelPriceCompare(group),
  })

  const probeErrors = Object.entries(data?.probe_errors ?? {})
  const models = useMemo(
    () =>
      filterPriceCompareModels(
        data?.models ?? [],
        modelFilter,
        channelFilter,
        riskFilter
      ),
    [channelFilter, data?.models, modelFilter, riskFilter]
  )
  const channels = useMemo(() => summarizePriceCompareModels(models), [models])
  const workbenchRows = useMemo(() => flattenWorkbenchRows(models), [models])
  const dirtyRows = useMemo(
    () => workbenchRows.filter((row) => isRowDirty(row, edits[row.key])),
    [workbenchRows, edits]
  )
  const riskRows = useMemo(
    () => workbenchRows.filter((row) => row.risk),
    [workbenchRows]
  )
  const sortedModels = useMemo(() => {
    if (sortBy === 'name') {
      return [...models].sort((a, b) =>
        a.model_name.localeCompare(b.model_name)
      )
    }
    const keyOf = (model: (typeof models)[number]) => {
      const rows = model.channels.map((channel) =>
        workbenchRowFromChannel(model, channel)
      )
      if (sortBy === 'profit-desc') {
        return -rows.reduce((acc, row) => acc + row.todayProfit, 0)
      }
      const margins = rows
        .map((row) => row.margin)
        .filter((margin): margin is number => margin !== null)
      return margins.length > 0 ? Math.min(...margins) : Number.MAX_VALUE
    }
    return [...models].sort((a, b) => keyOf(a) - keyOf(b))
  }, [models, sortBy])

  const handleEdit = (key: string, patch: Partial<RowEdit>) => {
    setEdits((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }))
  }
  const handleClearCost = (key: string) => {
    setEdits((prev) => {
      const edit = { ...prev[key] }
      delete edit.cost
      return { ...prev, [key]: edit }
    })
  }
  const handleAutotune = () => {
    const target = Number(targetMargin)
    const result = autotuneRows(
      workbenchRows,
      edits,
      autotuneScope,
      target,
      Number(autotuneStep)
    )
    setEdits((prev) => ({ ...prev, ...result.changes }))
    setAutotuneMsg(
      t(
        'Staged {{tuned}} rows ({{already}} already on target, {{skipped}} skipped)',
        {
          tuned: result.tuned,
          already: result.already,
          skipped: result.skipped,
        }
      )
    )
  }
  const handleExecuted = (keys: string[]) => {
    setEdits((prev) => {
      const next = { ...prev }
      for (const key of keys) delete next[key]
      return next
    })
  }
  const visibleSummary = useMemo(
    () => summarizeChannelRows(channels),
    [channels]
  )
  const generatedAt = data?.generated_at
    ? new Date(data.generated_at * 1000).toLocaleString()
    : null

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        {t('Channel Operations')}
      </SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <form
          className='flex items-center gap-2'
          onSubmit={(event) => {
            event.preventDefault()
            const nextGroup = groupInput.trim()
            if (nextGroup) setGroup(nextGroup)
          }}
        >
          <Input
            value={groupInput}
            onChange={(event) => setGroupInput(event.target.value)}
            className='h-8 w-32'
            aria-label={t('Pricing group')}
          />
          <Button type='submit' size='sm' variant='outline'>
            {t('Apply group')}
          </Button>
        </form>
        <Button
          variant='outline'
          size='sm'
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? <Spinner /> : <RefreshCw size={14} />}
          {t('Refresh')}
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        {canSyncPrice ? (
          <div className='mb-4 space-y-2'>
            <div className='flex flex-wrap items-center gap-2'>
              <span className='text-muted-foreground text-sm'>
                {t('Default target margin')}
              </span>
              <Input
                type='number'
                min={0}
                max={95}
                value={targetMargin}
                onChange={(event) => {
                  setTargetMargin(event.target.value)
                  localStorage.setItem(
                    TARGET_MARGIN_STORAGE_KEY,
                    event.target.value
                  )
                }}
                className='h-8 w-20 text-right tabular-nums'
                aria-label={t('Default target margin')}
              />
              <span className='text-muted-foreground text-sm'>%</span>
              <Button
                size='sm'
                onClick={() => setAutotuneOpen((open) => !open)}
              >
                {t('Auto-adjust by target margin')}
              </Button>
              <NativeSelect
                value={sortBy}
                onChange={(event) =>
                  setSortBy(event.target.value as typeof sortBy)
                }
                className='ml-auto w-44'
                aria-label={t('Sort models')}
              >
                <NativeSelectOption value='margin-asc'>
                  {t('Sort by margin asc')}
                </NativeSelectOption>
                <NativeSelectOption value='profit-desc'>
                  {t('Sort by today profit')}
                </NativeSelectOption>
                <NativeSelectOption value='name'>
                  {t('Sort by name')}
                </NativeSelectOption>
              </NativeSelect>
            </div>
            {autotuneOpen ? (
              <div className='bg-primary/5 border-primary/20 flex flex-wrap items-center gap-2 rounded-lg border p-3'>
                <span className='text-muted-foreground text-sm'>
                  {t('Scope')}
                </span>
                <NativeSelect
                  value={autotuneScope}
                  onChange={(event) =>
                    setAutotuneScope(event.target.value as AutotuneScope)
                  }
                  aria-label={t('Scope')}
                >
                  <NativeSelectOption value='below'>
                    {t('Only rows below target margin')}
                  </NativeSelectOption>
                  <NativeSelectOption value='all'>
                    {t('All rows with known cost')}
                  </NativeSelectOption>
                  <NativeSelectOption value='risk'>
                    {t('Risk rows only')}
                  </NativeSelectOption>
                </NativeSelect>
                <span className='text-muted-foreground text-sm'>
                  {t('Rounding')}
                </span>
                <NativeSelect
                  value={autotuneStep}
                  onChange={(event) => setAutotuneStep(event.target.value)}
                  aria-label={t('Rounding')}
                >
                  <NativeSelectOption value='0.1'>
                    {t('Round up to $0.1')}
                  </NativeSelectOption>
                  <NativeSelectOption value='0.25'>
                    {t('Round up to $0.25')}
                  </NativeSelectOption>
                  <NativeSelectOption value='0'>
                    {t('No rounding')}
                  </NativeSelectOption>
                </NativeSelect>
                <Button size='sm' onClick={handleAutotune}>
                  {t('Generate adjustments')}
                </Button>
                {autotuneMsg ? (
                  <span className='text-muted-foreground text-xs'>
                    {autotuneMsg}
                  </span>
                ) : null}
                <span className='text-muted-foreground text-xs'>
                  {t(
                    'Staged only — review below, then execute from the plan bar'
                  )}
                </span>
              </div>
            ) : null}
          </div>
        ) : (
          <div className='mb-4 flex justify-end'>
            <NativeSelect
              value={sortBy}
              onChange={(event) =>
                setSortBy(event.target.value as typeof sortBy)
              }
              className='w-44'
              aria-label={t('Sort models')}
            >
              <NativeSelectOption value='margin-asc'>
                {t('Sort by margin asc')}
              </NativeSelectOption>
              <NativeSelectOption value='profit-desc'>
                {t('Sort by today profit')}
              </NativeSelectOption>
              <NativeSelectOption value='name'>
                {t('Sort by name')}
              </NativeSelectOption>
            </NativeSelect>
          </div>
        )}
        {isLoading && (
          <div className='flex items-center justify-center py-16'>
            <Spinner className='size-6' />
          </div>
        )}
        {!isLoading && isError && (
          <Alert variant='destructive'>
            <AlertTriangle />
            <AlertTitle>
              {t('Channel operations could not be loaded')}
            </AlertTitle>
            <AlertDescription className='flex items-center justify-between gap-4'>
              <span>{t('Check the service and try again.')}</span>
              <Button size='sm' variant='outline' onClick={() => refetch()}>
                {t('Retry')}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {!isLoading && !isError && (
          <div className='space-y-6'>
            <div>
              <p className='text-muted-foreground max-w-3xl text-sm'>
                {t(
                  'See active routing, purchase prices, sales, profit, usage, and quality signals in one place.'
                )}
              </p>
              <div className='text-muted-foreground mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs'>
                <span>
                  {t('Pricing group')}: {data?.local_group || group}
                </span>
                {generatedAt ? (
                  <span>
                    {t('Generated at')}: {generatedAt}
                  </span>
                ) : null}
                <span>
                  {t('Prices use USD 1:1 and are shown per 1M tokens.')}
                </span>
              </div>
            </div>

            {riskRows.length > 0 ? (
              <div className='border-destructive/30 bg-destructive/5 rounded-lg border p-3'>
                <div className='text-destructive mb-2 text-sm font-medium'>
                  {t('Needs attention')}
                </div>
                <div className='flex flex-wrap gap-2'>
                  {riskRows.map((row) => {
                    const channel = models
                      .find((model) => model.model_name === row.modelName)
                      ?.channels.find(
                        (candidate) => candidate.channel_id === row.channelId
                      )
                    const firstRec = channel?.recommendations[0]
                    return (
                      <button
                        key={row.key}
                        type='button'
                        className='bg-destructive/10 text-destructive hover:bg-destructive/20 rounded-full px-3 py-1 text-xs'
                        onClick={() =>
                          document
                            .getElementById(`model-${row.modelName}`)
                            ?.scrollIntoView({
                              block: 'start',
                              behavior: 'smooth',
                            })
                        }
                      >
                        {row.modelName} · {row.channelName} ·{' '}
                        {firstRec
                          ? t(REC_LABEL_KEYS[firstRec] || firstRec)
                          : t('Review selling price or supplier')}
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : null}

            {data ? (
              <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-5'>
                <MetricCard
                  title={t('Today requests')}
                  value={visibleSummary.today.requests.toLocaleString()}
                  detail={t('Successful billed requests')}
                  icon={<TrendingUp className='size-5' aria-hidden='true' />}
                />
                <MetricCard
                  title={t('Today sales')}
                  value={formatUsd(visibleSummary.today.revenue)}
                  detail={t('Calculated from billed quota')}
                  icon={
                    <CircleDollarSign className='size-5' aria-hidden='true' />
                  }
                />
                <MetricCard
                  title={t('Estimated today cost')}
                  value={formatUsd(
                    visibleSummary.today.cost_available
                      ? visibleSummary.today.upstream_cost
                      : undefined
                  )}
                  detail={
                    visibleSummary.today.cost_available
                      ? t('Estimated from token usage')
                      : t('Some used models are missing purchase prices')
                  }
                  icon={
                    <CircleDollarSign className='size-5' aria-hidden='true' />
                  }
                />
                <MetricCard
                  title={t('Estimated today profit')}
                  value={formatUsd(
                    visibleSummary.today.cost_available
                      ? visibleSummary.today.profit
                      : undefined
                  )}
                  detail={
                    visibleSummary.today.cost_available
                      ? `${t('Margin')} ${formatPercent(visibleSummary.today.margin)}`
                      : t('Some used models are missing purchase prices')
                  }
                  tone={
                    visibleSummary.today.cost_available &&
                    visibleSummary.today.profit < 0
                      ? 'risk'
                      : 'normal'
                  }
                  icon={<TrendingUp className='size-5' aria-hidden='true' />}
                />
                <MetricCard
                  title={t('Risk channels')}
                  value={String(visibleSummary.risk_channels)}
                  detail={t('Need manual review')}
                  tone={visibleSummary.risk_channels > 0 ? 'risk' : 'normal'}
                  icon={<ShieldAlert className='size-5' aria-hidden='true' />}
                />
              </div>
            ) : null}

            {probeErrors.length > 0 ? (
              <Alert variant='destructive'>
                <AlertTriangle />
                <AlertTitle>{t('Upstream probe errors')}</AlertTitle>
                <AlertDescription>
                  <ul className='list-disc space-y-1 pl-4'>
                    {probeErrors.map(([channelLabel, message]) => (
                      <li key={channelLabel}>
                        <span className='font-mono break-all'>
                          {channelLabel}
                        </span>
                        : {t(message)}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            {channels.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>{t('Channel business overview')}</CardTitle>
                </CardHeader>
                <CardContent className='p-0'>
                  <ChannelSummaryTable rows={channels} />
                </CardContent>
              </Card>
            ) : null}

            <div className='space-y-3'>
              <div>
                <h2 className='text-lg font-semibold'>
                  {t('Model routing details')}
                </h2>
                <p className='text-muted-foreground text-xs'>
                  {t(
                    'Higher priority routes first; equal priorities share traffic by weight.'
                  )}
                </p>
              </div>
              <div className='flex flex-wrap items-center gap-2'>
                <div className='relative min-w-56 flex-1'>
                  <Search
                    className='text-muted-foreground absolute top-2.5 left-2.5 size-4'
                    aria-hidden='true'
                  />
                  <Input
                    value={modelFilter}
                    onChange={(event) => setModelFilter(event.target.value)}
                    placeholder={t('Search models')}
                    aria-label={t('Search models')}
                    className='pl-8'
                  />
                </div>
                <div className='relative min-w-56 flex-1'>
                  <Search
                    className='text-muted-foreground absolute top-2.5 left-2.5 size-4'
                    aria-hidden='true'
                  />
                  <Input
                    value={channelFilter}
                    onChange={(event) => setChannelFilter(event.target.value)}
                    placeholder={t('Search channels')}
                    aria-label={t('Search channels')}
                    className='pl-8'
                  />
                </div>
                <div
                  className='flex items-center gap-1'
                  aria-label={t('Risk')}
                  role='group'
                >
                  <Button
                    aria-pressed={riskFilter === 'all'}
                    type='button'
                    size='sm'
                    variant={riskFilter === 'all' ? 'default' : 'outline'}
                    onClick={() => setRiskFilter('all')}
                  >
                    {t('All')}
                  </Button>
                  <Button
                    type='button'
                    aria-pressed={riskFilter === 'risk'}
                    size='sm'
                    variant={riskFilter === 'risk' ? 'default' : 'outline'}
                    onClick={() => setRiskFilter('risk')}
                  >
                    {t('Risk only')}
                  </Button>
                  <Button
                    type='button'
                    size='sm'
                    aria-pressed={riskFilter === 'normal'}
                    variant={riskFilter === 'normal' ? 'default' : 'outline'}
                    onClick={() => setRiskFilter('normal')}
                  >
                    {t('Normal only')}
                  </Button>
                </div>
              </div>
            </div>

            {models.length === 0 ? (
              <div className='text-muted-foreground py-16 text-center text-sm'>
                {t('No models to compare')}
              </div>
            ) : (
              sortedModels.map((model) => (
                <PriceCompareTable
                  key={model.model_name}
                  model={model}
                  group={group}
                  canSyncPrice={canSyncPrice}
                  edits={edits}
                  onEdit={handleEdit}
                  onClearCost={handleClearCost}
                />
              ))
            )}
          </div>
        )}
        {canSyncPrice && dirtyRows.length > 0 ? (
          <div className='bg-background/95 fixed inset-x-0 bottom-0 z-20 border-t py-3 shadow-lg backdrop-blur'>
            <div className='mx-auto flex max-w-7xl items-center justify-between px-6'>
              <span className='text-sm'>
                {t('{{count}} rows staged', { count: dirtyRows.length })}
              </span>
              <div className='flex gap-2'>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => setEdits({})}
                >
                  {t('Discard changes')}
                </Button>
                <Button size='sm' onClick={() => setPlanOpen(true)}>
                  {t('Review plan & execute')}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        <WorkbenchPlanDialog
          open={planOpen}
          onOpenChange={setPlanOpen}
          rows={workbenchRows}
          edits={edits}
          group={group}
          onExecuted={handleExecuted}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
