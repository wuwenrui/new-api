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
import { ArrowDown, ArrowUp, ArrowUpDown, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import {
  formatPercent,
  formatUsd,
  sortChannelSummaries,
  type ChannelSummarySort,
  type SortDirection,
} from '../lib/formatters'
import type { BusinessMetrics, ChannelSummary } from '../types'

function profitTextClass(metrics: BusinessMetrics): string {
  if (!metrics.cost_available) return 'text-muted-foreground'
  if (metrics.profit < 0) return 'text-destructive'
  return 'text-emerald-600 dark:text-emerald-400'
}

function SortableHead(props: {
  label: string
  sortKey: ChannelSummarySort
  activeSort: ChannelSummarySort
  direction: SortDirection
  onSort: (sort: ChannelSummarySort) => void
}) {
  const active = props.sortKey === props.activeSort
  let SortIcon = ArrowUpDown
  let ariaSort: 'none' | 'ascending' | 'descending' = 'none'
  if (active) {
    SortIcon = props.direction === 'asc' ? ArrowUp : ArrowDown
    ariaSort = props.direction === 'asc' ? 'ascending' : 'descending'
  }
  return (
    <TableHead className='text-right' aria-sort={ariaSort}>
      <Button
        type='button'
        variant='ghost'
        size='sm'
        className='h-7 px-1 text-xs'
        aria-label={`${props.label}: ${active ? props.direction : 'sort'}`}
        onClick={() => props.onSort(props.sortKey)}
      >
        {props.label}
        <SortIcon className='size-3' aria-hidden='true' />
      </Button>
    </TableHead>
  )
}

export function ChannelSummaryTable(props: { rows: ChannelSummary[] }) {
  const { t } = useTranslation()
  const [sort, setSort] = useState<ChannelSummarySort>('risk')
  const [direction, setDirection] = useState<SortDirection>('desc')
  const rows = sortChannelSummaries(props.rows, sort, direction)
  const handleSort = (nextSort: ChannelSummarySort) => {
    if (nextSort === sort) {
      setDirection((current) => (current === 'desc' ? 'asc' : 'desc'))
      return
    }
    setSort(nextSort)
    setDirection('desc')
  }
  return (
    <div className='overflow-x-auto'>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('Channel')}</TableHead>
            <TableHead>{t('Models')}</TableHead>
            <SortableHead
              label={t('Risk')}
              sortKey='risk'
              activeSort={sort}
              direction={direction}
              onSort={handleSort}
            />
            <SortableHead
              label={t('Today sales')}
              sortKey='today_revenue'
              activeSort={sort}
              direction={direction}
              onSort={handleSort}
            />
            <SortableHead
              label={t('Estimated today cost')}
              sortKey='today_cost'
              activeSort={sort}
              direction={direction}
              onSort={handleSort}
            />
            <SortableHead
              label={t('Estimated today profit')}
              sortKey='today_profit'
              activeSort={sort}
              direction={direction}
              onSort={handleSort}
            />
            <SortableHead
              label={t('Margin')}
              sortKey='today_margin'
              activeSort={sort}
              direction={direction}
              onSort={handleSort}
            />
            <SortableHead
              label={t('Today requests')}
              sortKey='today_requests'
              activeSort={sort}
              direction={direction}
              onSort={handleSort}
            />
            <SortableHead
              label={t('Total sales')}
              sortKey='total_revenue'
              activeSort={sort}
              direction={direction}
              onSort={handleSort}
            />
            <SortableHead
              label={t('Estimated total cost')}
              sortKey='total_cost'
              activeSort={sort}
              direction={direction}
              onSort={handleSort}
            />
            <SortableHead
              label={t('Estimated total profit')}
              sortKey='total_profit'
              activeSort={sort}
              direction={direction}
              onSort={handleSort}
            />
            <TableHead className='text-right'>{t('Manage')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.channel_id}>
              <TableCell>
                <div className='font-medium'>{row.channel_name}</div>
                <div className='text-muted-foreground text-xs'>
                  #{row.channel_id}
                </div>
              </TableCell>
              <TableCell className='tabular-nums'>{row.model_count}</TableCell>
              <TableCell>
                {row.risk_count > 0 ? (
                  <Badge variant='destructive'>{row.risk_count}</Badge>
                ) : (
                  <Badge variant='secondary'>{t('Normal')}</Badge>
                )}
              </TableCell>
              <TableCell className='text-right tabular-nums'>
                {formatUsd(row.today.revenue)}
              </TableCell>
              <TableCell className='text-right tabular-nums'>
                {formatUsd(
                  row.today.cost_available ? row.today.upstream_cost : undefined
                )}
              </TableCell>
              <TableCell className='text-right tabular-nums'>
                <span className={profitTextClass(row.today)}>
                  {formatUsd(
                    row.today.cost_available ? row.today.profit : undefined
                  )}
                </span>
              </TableCell>
              <TableCell className='text-right tabular-nums'>
                {formatPercent(
                  row.today.cost_available ? row.today.margin : undefined
                )}
              </TableCell>
              <TableCell className='text-right tabular-nums'>
                {row.today.requests}
              </TableCell>
              <TableCell className='text-right tabular-nums'>
                <div>{formatUsd(row.total.revenue)}</div>
                <div className='text-muted-foreground text-xs'>
                  {row.total.requests} {t('requests')}
                </div>
              </TableCell>
              <TableCell className='text-right tabular-nums'>
                {formatUsd(
                  row.total.cost_available ? row.total.upstream_cost : undefined
                )}
              </TableCell>
              <TableCell className='text-right tabular-nums'>
                <span className={profitTextClass(row.total)}>
                  {formatUsd(
                    row.total.cost_available ? row.total.profit : undefined
                  )}
                </span>
              </TableCell>
              <TableCell className='text-right'>
                <Button
                  size='sm'
                  variant='outline'
                  render={
                    <Link to='/channels' search={{ edit: row.channel_id }} />
                  }
                >
                  <Settings2 className='size-3.5' aria-hidden='true' />
                  {t('Edit')}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
