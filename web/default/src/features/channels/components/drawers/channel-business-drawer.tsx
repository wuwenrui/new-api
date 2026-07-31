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
import { AlertTriangle, TrendingUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  sideDrawerContentClassName,
  sideDrawerFormClassName,
  sideDrawerHeaderClassName,
} from '@/components/drawer-layout'
import { StatusBadge } from '@/components/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
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
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { formatCurrencyFromUSD } from '@/lib/currency'

import { CHANNEL_STATUS_CONFIG } from '../../constants'
import { useChannelBusinessReport } from '../../hooks/use-channel-business-report'
import type { Channel, ChannelBusinessModelRow } from '../../types'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  channel: Channel | null
}

const PLACEHOLDER = '—'

function formatUsdPerMillion(value: number): string {
  if (!Number.isFinite(value)) return PLACEHOLDER
  return `$${value.toFixed(2)}`
}

function marginToneClass(value: number): string {
  if (!Number.isFinite(value)) return 'text-muted-foreground'
  if (value < 0) return 'text-red-600 dark:text-red-500'
  if (value < 20) return 'text-amber-600 dark:text-amber-500'
  return 'text-green-600 dark:text-green-500'
}

function MetricCard({
  label,
  value,
  valueClassName,
  hint,
}: {
  label: string
  value: React.ReactNode
  valueClassName?: string
  hint?: string
}) {
  const body = (
    <div className='rounded-md border p-3'>
      <div className='text-muted-foreground text-xs'>{label}</div>
      <div className={`mt-1 text-sm font-semibold ${valueClassName ?? ''}`}>
        {value}
      </div>
    </div>
  )
  if (!hint) return body
  return (
    <Tooltip>
      <TooltipTrigger render={body} />
      <TooltipContent>
        <p className='max-w-xs'>{hint}</p>
      </TooltipContent>
    </Tooltip>
  )
}

function UnknownPriceCell({ reason }: { reason?: string }) {
  const { t } = useTranslation()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className='text-muted-foreground cursor-help text-xs underline decoration-dotted underline-offset-2'>
            {t('Unknown')}
          </span>
        }
      />
      <TooltipContent>
        <p className='max-w-xs'>{reason || t('Unknown')}</p>
      </TooltipContent>
    </Tooltip>
  )
}

function ModelPriceCells({ model }: { model: ChannelBusinessModelRow }) {
  const { t } = useTranslation()
  return (
    <>
      <TableCell className='text-right tabular-nums'>
        {model.local_price_known ? (
          `${formatUsdPerMillion(model.local_input_price)} / ${formatUsdPerMillion(model.local_output_price)}`
        ) : (
          <UnknownPriceCell
            reason={t('Local sale price is not configured for this model')}
          />
        )}
      </TableCell>
      <TableCell className='text-right tabular-nums'>
        {model.cost_known ? (
          `${formatUsdPerMillion(model.upstream_input_price)} / ${formatUsdPerMillion(model.upstream_output_price)}`
        ) : (
          <UnknownPriceCell reason={model.cost_unknown_reason} />
        )}
      </TableCell>
    </>
  )
}

export function ChannelBusinessDrawer({ open, onOpenChange, channel }: Props) {
  const { t } = useTranslation()
  const { report, rowByChannelId, isLoading } = useChannelBusinessReport()

  const row = channel ? rowByChannelId.get(channel.id) : undefined
  const days = report?.days ?? 30
  const statusConfig =
    CHANNEL_STATUS_CONFIG[
      (row?.status ?? channel?.status ?? 1) as keyof typeof CHANNEL_STATUS_CONFIG
    ] ?? CHANNEL_STATUS_CONFIG[1]

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className={sideDrawerContentClassName('sm:max-w-2xl')}>
        <SheetHeader className={sideDrawerHeaderClassName()}>
          <SheetTitle className='flex items-center gap-2'>
            <TrendingUp className='h-4 w-4' />
            {t('Business details')}
            {channel && (
              <>
                <span className='font-normal'>{channel.name}</span>
                <StatusBadge
                  label={t(statusConfig.label)}
                  variant={statusConfig.variant}
                  size='sm'
                  copyable={false}
                />
              </>
            )}
          </SheetTitle>
        </SheetHeader>
        <div className={sideDrawerFormClassName()}>
          <TooltipProvider>
            <div className='space-y-4'>
              {isLoading && (
                <div className='text-muted-foreground py-8 text-center text-sm'>
                  {t('Loading...')}
                </div>
              )}

              {!isLoading && !row && (
                <div className='text-muted-foreground py-8 text-center text-sm'>
                  {t('No usage in period')}
                </div>
              )}

              {!isLoading && row && (
                <>
                  {/* Alerts */}
                  {row.price_changed && (
                    <Alert className='border-amber-500 text-amber-600 dark:text-amber-500'>
                      <AlertTriangle />
                      <AlertTitle>
                        {t('Upstream price changed since last inspection')}
                      </AlertTitle>
                    </Alert>
                  )}
                  {row.low_balance && (
                    <Alert className='border-amber-500 text-amber-600 dark:text-amber-500'>
                      <AlertTriangle />
                      <AlertTitle>
                        {t('Low upstream balance (under ${{threshold}})', {
                          threshold: (
                            report?.low_balance_threshold ?? 10
                          ).toFixed(0),
                        })}
                      </AlertTitle>
                    </Alert>
                  )}
                  {!row.cost_known && (
                    <Alert>
                      <AlertTriangle />
                      <AlertTitle>
                        {t(
                          'Cost unknown: register probe credentials in Upstream sites'
                        )}
                      </AlertTitle>
                      {row.cost_unknown_reason && (
                        <AlertDescription>
                          {row.cost_unknown_reason}
                        </AlertDescription>
                      )}
                    </Alert>
                  )}
                  {row.cost_known && row.cost_partial && (
                    <Alert>
                      <AlertTriangle />
                      <AlertTitle>
                        {t(
                          'Some models lack upstream pricing; cost and profit are partial estimates'
                        )}
                      </AlertTitle>
                    </Alert>
                  )}

                  {/* Metric cards */}
                  <div className='grid grid-cols-2 gap-3 sm:grid-cols-3'>
                    <MetricCard
                      label={t('Revenue')}
                      value={formatCurrencyFromUSD(row.revenue)}
                    />
                    <MetricCard
                      label={t('Estimated Upstream Cost')}
                      value={
                        row.cost_known
                          ? formatCurrencyFromUSD(row.estimated_upstream_cost)
                          : t('Unknown')
                      }
                      hint={t(
                        'Estimated from real token usage × upstream ratios'
                      )}
                    />
                    <MetricCard
                      label={t('Gross profit')}
                      value={
                        row.cost_known
                          ? formatCurrencyFromUSD(row.gross_profit)
                          : t('Unknown')
                      }
                    />
                    <MetricCard
                      label={t('Gross margin')}
                      value={
                        row.cost_known
                          ? `${row.gross_margin >= 0 ? '+' : ''}${row.gross_margin.toFixed(1)}%`
                          : t('Unknown')
                      }
                      valueClassName={
                        row.cost_known
                          ? marginToneClass(row.gross_margin)
                          : undefined
                      }
                    />
                    <MetricCard
                      label={t('Balance')}
                      value={formatCurrencyFromUSD(row.balance)}
                      hint={t('Current upstream account balance')}
                    />
                    <MetricCard
                      label={t('Upstream group')}
                      value={
                        row.upstream_group ? (
                          row.upstream_group
                        ) : (
                          <span className='text-muted-foreground'>
                            {PLACEHOLDER}
                          </span>
                        )
                      }
                    />
                  </div>

                  {/* Top models */}
                  <div className='space-y-2'>
                    <div className='flex items-center gap-2 text-sm font-semibold'>
                      {t('Top models')}
                      <Badge variant='secondary'>
                        {row.top_models.length}
                      </Badge>
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('Model')}</TableHead>
                          <TableHead className='text-right'>
                            {t('Local sale price $/1M (In / Out)')}
                          </TableHead>
                          <TableHead className='text-right'>
                            {t('Upstream cost price $/1M (In / Out)')}
                          </TableHead>
                          <TableHead className='text-right'>
                            {t('Margin')}
                          </TableHead>
                          <TableHead className='text-right'>
                            {t('Revenue')}
                          </TableHead>
                          <TableHead className='text-right'>
                            {t('Cost')}
                          </TableHead>
                          <TableHead className='text-right'>
                            {t('Profit')}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {row.top_models.length === 0 && (
                          <TableRow>
                            <TableCell
                              colSpan={7}
                              className='text-muted-foreground py-8 text-center'
                            >
                              {t('No usage in period')}
                            </TableCell>
                          </TableRow>
                        )}
                        {row.top_models.map((model) => (
                          <TableRow key={model.model_name}>
                            <TableCell className='max-w-40 truncate font-mono text-xs'>
                              {model.model_name}
                              {model.price_changed && (
                                <Badge
                                  variant='outline'
                                  className='ml-1.5 border-amber-500 text-amber-600 dark:text-amber-500'
                                >
                                  {t('Price changed')}
                                </Badge>
                              )}
                            </TableCell>
                            <ModelPriceCells model={model} />
                            <TableCell className='text-right tabular-nums'>
                              {model.cost_known ? (
                                <span
                                  className={marginToneClass(
                                    model.gross_margin
                                  )}
                                >
                                  {`${model.gross_margin >= 0 ? '+' : ''}${model.gross_margin.toFixed(1)}%`}
                                </span>
                              ) : (
                                <UnknownPriceCell
                                  reason={model.cost_unknown_reason}
                                />
                              )}
                            </TableCell>
                            <TableCell className='text-right tabular-nums'>
                              {formatCurrencyFromUSD(model.revenue)}
                            </TableCell>
                            <TableCell className='text-right tabular-nums'>
                              {model.cost_known ? (
                                formatCurrencyFromUSD(
                                  model.estimated_upstream_cost
                                )
                              ) : (
                                <UnknownPriceCell
                                  reason={model.cost_unknown_reason}
                                />
                              )}
                            </TableCell>
                            <TableCell className='text-right tabular-nums'>
                              {model.cost_known ? (
                                formatCurrencyFromUSD(model.gross_profit)
                              ) : (
                                <UnknownPriceCell
                                  reason={model.cost_unknown_reason}
                                />
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  <div className='text-muted-foreground text-xs'>
                    {t('Last {{days}} days', { days })} ·{' '}
                    {t('Estimated from real token usage × upstream ratios')}
                  </div>
                </>
              )}
            </div>
          </TooltipProvider>
        </div>
      </SheetContent>
    </Sheet>
  )
}
