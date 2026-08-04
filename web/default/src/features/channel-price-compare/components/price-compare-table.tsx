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
import { Link } from '@tanstack/react-router'
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  FileSearch,
  Settings2,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

import { formatPercent, formatUsd } from '../lib/formatters'
import type { PriceCompareChannel, PriceCompareModel } from '../types'
import { PriceSyncDialog } from './price-sync-dialog'

const RECOMMENDATION_KEYS: Record<string, string> = {
  missing_price: 'Add purchase price',
  price_changed: 'Check upstream price change',
  negative_margin: 'Adjust price or stop after review',
  low_margin: 'Review selling price or supplier',
  low_success_rate: 'Lower priority or stop after review',
}

function routingBadge(channel: PriceCompareChannel) {
  if (channel.routing_role === 'primary') {
    return <Badge>{channel.priority}</Badge>
  }
  if (channel.routing_role === 'primary_pool') {
    return <Badge variant='secondary'>{channel.priority}</Badge>
  }
  return <Badge variant='outline'>{channel.priority}</Badge>
}

function routingLabelKey(
  role: PriceCompareChannel['routing_role']
): 'Primary' | 'Primary pool' | 'Backup' {
  if (role === 'primary') {
    return 'Primary'
  }
  if (role === 'primary_pool') {
    return 'Primary pool'
  }
  return 'Backup'
}

function profitTextClass(costAvailable: boolean, profit: number): string {
  if (!costAvailable) return 'text-muted-foreground text-xs'
  if (profit < 0) return 'text-destructive text-xs'
  return 'text-xs text-emerald-600 dark:text-emerald-400'
}

function PriceCell(props: { channel: PriceCompareChannel }) {
  const { t } = useTranslation()
  if (props.channel.status !== 'ok') {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type='button'
              className='text-muted-foreground cursor-help underline decoration-dotted underline-offset-2'
            >
              {t('Price not maintained')}
            </button>
          }
        />
        <TooltipContent>{t(props.channel.status_reason)}</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <div className='space-y-1 text-right tabular-nums'>
      <div>
        {formatUsd(props.channel.upstream_input)} /{' '}
        {formatUsd(props.channel.upstream_output)}
      </div>
      <div className='text-muted-foreground text-xs'>
        {t('Cache Read')} / {t('Cache Write')}:{' '}
        {formatUsd(props.channel.upstream_cache_read)} /{' '}
        {formatUsd(props.channel.upstream_cache_write)}
      </div>
      <div className='text-muted-foreground text-xs'>
        {props.channel.price_source === 'manual'
          ? t('Manual price')
          : t('Detected price')}
      </div>
      {props.channel.price_source === 'manual' &&
      props.channel.detected_available ? (
        <div
          className={
            props.channel.price_changed
              ? 'text-xs text-amber-600 dark:text-amber-400'
              : 'text-muted-foreground text-xs'
          }
        >
          <div>
            {t('Detected')}: {formatUsd(props.channel.detected_input)} /{' '}
            {formatUsd(props.channel.detected_output)}
          </div>
          <div>
            {t('Cache Read')} / {t('Cache Write')}:{' '}
            {formatUsd(props.channel.detected_cache_read)} /{' '}
            {formatUsd(props.channel.detected_cache_write)}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ChannelRow(props: {
  channel: PriceCompareChannel
  modelName: string
  onSyncPrice: (channel: PriceCompareChannel) => void
  canSyncPrice: boolean
}) {
  const { t } = useTranslation()
  const attempts =
    props.channel.quality_24h.successes + props.channel.quality_24h.errors

  return (
    <TableRow
      className={
        props.channel.recommendations.length > 0
          ? 'bg-amber-50/50 dark:bg-amber-950/10'
          : undefined
      }
    >
      <TableCell>
        <div className='flex items-center gap-2'>
          {routingBadge(props.channel)}
          <span className='text-xs'>
            {t(routingLabelKey(props.channel.routing_role))}
          </span>
        </div>
        <div className='text-muted-foreground mt-1 text-xs'>
          {t('Weight')} {props.channel.weight}
        </div>
      </TableCell>
      <TableCell>
        <div className='font-medium'>{props.channel.channel_name}</div>
        <div className='text-muted-foreground text-xs'>
          {props.channel.upstream_group || t('No upstream group')}
        </div>
        {props.channel.upstream_model !== props.modelName ? (
          <div className='text-muted-foreground font-mono text-xs'>
            {props.channel.upstream_model}
          </div>
        ) : null}
      </TableCell>
      <TableCell>
        <PriceCell channel={props.channel} />
      </TableCell>
      <TableCell className='text-right tabular-nums'>
        {props.channel.uses_fixed_price ? (
          <>
            <div>{formatUsd(props.channel.fixed_price)}</div>
            <div className='text-muted-foreground text-xs'>
              {t('Fixed price')} · {t('per request')}
            </div>
          </>
        ) : (
          <>
            <div>
              {formatUsd(props.channel.local_input)} /{' '}
              {formatUsd(props.channel.local_output)}
            </div>
            <div className='text-muted-foreground text-xs'>
              {props.channel.billing_mode === 'tiered_expr'
                ? t('Tiered by context')
                : formatPercent(
                    props.channel.price_source === 'missing'
                      ? undefined
                      : Math.min(
                          props.channel.margin_input,
                          props.channel.margin_output
                        )
                  )}
            </div>
          </>
        )}
      </TableCell>
      <TableCell className='text-right tabular-nums'>
        <div>{formatUsd(props.channel.today.revenue)}</div>
        <div className='text-muted-foreground text-xs'>
          {props.channel.today.requests} {t('requests')}
        </div>
      </TableCell>
      <TableCell className='text-right tabular-nums'>
        <div>
          {formatUsd(
            props.channel.today.cost_available
              ? props.channel.today.upstream_cost
              : undefined
          )}
        </div>
        <div
          className={profitTextClass(
            props.channel.today.cost_available,
            props.channel.today.profit
          )}
        >
          {t('Profit')}{' '}
          {formatUsd(
            props.channel.today.cost_available
              ? props.channel.today.profit
              : undefined
          )}
        </div>
      </TableCell>
      <TableCell className='text-right tabular-nums'>
        <div>{formatUsd(props.channel.total.revenue)}</div>
        <div className='text-muted-foreground text-xs'>
          {t('Estimated cost')}{' '}
          {formatUsd(
            props.channel.total.cost_available
              ? props.channel.total.upstream_cost
              : undefined
          )}{' '}
          · {props.channel.total.requests} {t('requests')}
        </div>
        <div
          className={profitTextClass(
            props.channel.total.cost_available,
            props.channel.total.profit
          )}
        >
          {t('Profit')}{' '}
          {formatUsd(
            props.channel.total.cost_available
              ? props.channel.total.profit
              : undefined
          )}
        </div>
      </TableCell>
      <TableCell>
        {attempts > 0 ? (
          <>
            <div
              className={
                props.channel.quality_24h.success_rate < 95
                  ? 'text-destructive font-medium'
                  : 'font-medium'
              }
            >
              {formatPercent(props.channel.quality_24h.success_rate)}
            </div>
            <div className='text-muted-foreground text-xs'>
              {props.channel.quality_24h.successes} /{' '}
              {props.channel.quality_24h.errors} ·{' '}
              {props.channel.quality_24h.average_use_time.toFixed(1)}s
            </div>
            {props.channel.quality_24h.last_error_code ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type='button'
                      className='text-destructive cursor-help text-xs underline decoration-dotted underline-offset-2'
                    >
                      {t('Latest error')}
                    </button>
                  }
                />
                <TooltipContent>
                  <p className='max-w-sm'>
                    {t(props.channel.quality_24h.last_error_code)}
                  </p>
                </TooltipContent>
              </Tooltip>
            ) : null}
          </>
        ) : (
          <span className='text-muted-foreground'>—</span>
        )}
      </TableCell>
      <TableCell>
        <div className='flex max-w-56 flex-wrap gap-1'>
          {props.channel.recommendations.length === 0 ? (
            <Badge variant='secondary'>{t('Normal')}</Badge>
          ) : (
            props.channel.recommendations.map((code) => (
              <Badge key={code} variant='outline'>
                {t(RECOMMENDATION_KEYS[code] || code)}
              </Badge>
            ))
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className='flex gap-1'>
          {props.canSyncPrice ? (
            <Button
              size='icon-sm'
              variant='outline'
              aria-label={t('Sync selling price')}
              onClick={() => props.onSyncPrice(props.channel)}
            >
              <ArrowLeftRight aria-hidden='true' />
            </Button>
          ) : null}
          <Button
            size='icon-sm'
            variant='outline'
            aria-label={t('Edit channel')}
            render={
              <Link
                to='/channels'
                search={{ edit: props.channel.channel_id }}
              />
            }
          >
            <Settings2 aria-hidden='true' />
          </Button>
          <Button
            size='icon-sm'
            variant='outline'
            aria-label={t('View logs')}
            render={
              <Link
                to='/usage-logs/$section'
                params={{ section: 'common' }}
                search={{
                  model: props.modelName,
                  channel: String(props.channel.channel_id),
                }}
              />
            }
          >
            <FileSearch aria-hidden='true' />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

export function PriceCompareTable(props: {
  model: PriceCompareModel
  group: string
  canSyncPrice: boolean
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(true)
  const [syncTarget, setSyncTarget] = useState<PriceCompareChannel | null>(null)

  return (
    <Card>
      <CardHeader className='border-b p-0'>
        <CardTitle>
          <Button
            type='button'
            variant='ghost'
            className='h-auto w-full justify-between rounded-none px-6 py-4 font-mono text-base'
            aria-expanded={expanded}
            aria-label={`${t(expanded ? 'Collapse' : 'Expand')} ${props.model.model_name}`}
            onClick={() => setExpanded((current) => !current)}
          >
            <span className='flex min-w-0 items-center gap-2 break-all'>
              {expanded ? (
                <ChevronDown className='size-4 shrink-0' aria-hidden='true' />
              ) : (
                <ChevronRight className='size-4 shrink-0' aria-hidden='true' />
              )}
              {props.model.model_name}
            </span>
            <Badge variant='outline'>
              {props.model.channels.length} {t('channels')}
            </Badge>
          </Button>
        </CardTitle>
      </CardHeader>
      {expanded ? (
        <CardContent className='p-0'>
          <div className='overflow-x-auto'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Routing')}</TableHead>
                  <TableHead>{t('Channel / group')}</TableHead>
                  <TableHead className='text-right'>
                    {t('Purchase price input / output')}
                  </TableHead>
                  <TableHead className='text-right'>
                    {t('Selling price / margin')}
                  </TableHead>
                  <TableHead className='text-right'>
                    {t('Today sales')}
                  </TableHead>
                  <TableHead className='text-right'>
                    {t('Estimated today cost / profit')}
                  </TableHead>
                  <TableHead className='text-right'>
                    {t('Total sales / estimated cost / profit')}
                  </TableHead>
                  <TableHead>{t('24h success')}</TableHead>
                  <TableHead>{t('Management advice')}</TableHead>
                  <TableHead>{t('Actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {props.model.channels.map((channel) => (
                  <ChannelRow
                    key={channel.channel_id}
                    channel={channel}
                    modelName={props.model.model_name}
                    canSyncPrice={props.canSyncPrice}
                    onSyncPrice={setSyncTarget}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      ) : null}
      {props.canSyncPrice ? (
        <PriceSyncDialog
          open={syncTarget !== null}
          onOpenChange={(open) => {
            if (!open) setSyncTarget(null)
          }}
          modelName={props.model.model_name}
          channel={syncTarget}
          group={props.group}
        />
      ) : null}
    </Card>
  )
}
