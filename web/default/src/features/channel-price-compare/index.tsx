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
import { Spinner } from '@/components/ui/spinner'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { getChannelPriceCompare } from './api'
import { ChannelSummaryTable } from './components/channel-summary-table'
import { PriceCompareTable } from './components/price-compare-table'
import {
  filterPriceCompareModels,
  formatPercent,
  formatUsd,
  summarizeChannelRows,
  summarizePriceCompareModels,
  type ChannelRiskFilter,
} from './lib/formatters'

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
              models.map((model) => (
                <PriceCompareTable
                  key={model.model_name}
                  model={model}
                  group={group}
                  canSyncPrice={canSyncPrice}
                />
              ))
            )}
          </div>
        )}
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
