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

import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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

import type { PriceCompareChannel, PriceCompareModel } from '../types'

const PLACEHOLDER = '—'

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return PLACEHOLDER
  return `$${value.toFixed(2)}`
}

function formatMargin(value: number): string {
  if (!Number.isFinite(value)) return PLACEHOLDER
  return `${value.toFixed(1)}%`
}

function marginToneClass(value: number): string {
  if (!Number.isFinite(value)) return 'text-muted-foreground'
  if (value < 0) return 'text-red-500'
  if (value < 20) return 'text-amber-600 dark:text-amber-500'
  return 'text-green-600 dark:text-green-500'
}

// Cell content for columns that are only meaningful when the upstream probe
// succeeded (status === 'ok'). For unknown channels show a placeholder that
// reveals status_reason on hover instead of rendering NaN.
function UnknownReason({ reason }: { reason: string }) {
  if (!reason) {
    return <span className='text-muted-foreground'>{PLACEHOLDER}</span>
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className='text-muted-foreground cursor-help underline decoration-dotted underline-offset-2'>
            {PLACEHOLDER}
          </span>
        }
      />
      <TooltipContent>
        <p className='max-w-xs'>{reason}</p>
      </TooltipContent>
    </Tooltip>
  )
}

function ChannelRow({ channel }: { channel: PriceCompareChannel }) {
  const { t } = useTranslation()
  const isOk = channel.status === 'ok'

  const upstreamCell = (value: number) =>
    isOk ? (
      formatUsd(value)
    ) : (
      <UnknownReason reason={channel.status_reason} />
    )

  const marginCell = (value: number) =>
    isOk ? (
      <span className={marginToneClass(value)}>{formatMargin(value)}</span>
    ) : (
      <UnknownReason reason={channel.status_reason} />
    )

  return (
    <TableRow>
      <TableCell className='tabular-nums'>{channel.priority}</TableCell>
      <TableCell className='font-medium'>{channel.channel_name}</TableCell>
      <TableCell>{channel.upstream_group || PLACEHOLDER}</TableCell>
      <TableCell>
        {isOk ? (
          <Badge variant='secondary'>{t('OK')}</Badge>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge variant='outline' className='cursor-help'>
                  {t('Unknown')}
                </Badge>
              }
            />
            <TooltipContent>
              <p className='max-w-xs'>
                {channel.status_reason || t('Unknown')}
              </p>
            </TooltipContent>
          </Tooltip>
        )}
      </TableCell>
      <TableCell className='text-right tabular-nums'>
        {upstreamCell(channel.upstream_input)}
      </TableCell>
      <TableCell className='text-right tabular-nums'>
        {upstreamCell(channel.upstream_output)}
      </TableCell>
      <TableCell className='text-right tabular-nums'>
        {upstreamCell(channel.upstream_cache_read)}
      </TableCell>
      <TableCell className='text-right tabular-nums'>
        {upstreamCell(channel.upstream_cache_write)}
      </TableCell>
      <TableCell className='text-right tabular-nums'>
        {formatUsd(channel.local_input)}
      </TableCell>
      <TableCell className='text-right tabular-nums'>
        {formatUsd(channel.local_output)}
      </TableCell>
      <TableCell className='text-right tabular-nums'>
        {formatUsd(channel.local_cache_read)}
      </TableCell>
      <TableCell className='text-right tabular-nums'>
        {formatUsd(channel.local_cache_write)}
      </TableCell>
      <TableCell className='text-right tabular-nums'>
        {marginCell(channel.margin_input)}
      </TableCell>
      <TableCell className='text-right tabular-nums'>
        {marginCell(channel.margin_output)}
      </TableCell>
    </TableRow>
  )
}

export function PriceCompareTable({ model }: { model: PriceCompareModel }) {
  const { t } = useTranslation()

  return (
    <Card>
      <CardHeader className='border-b'>
        <CardTitle className='font-mono text-base break-all'>
          {model.model_name}
        </CardTitle>
      </CardHeader>
      <CardContent className='p-0'>
        <div className='overflow-x-auto'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead rowSpan={2}>{t('Priority')}</TableHead>
              <TableHead rowSpan={2}>{t('Channel Name')}</TableHead>
              <TableHead rowSpan={2}>{t('Upstream Group')}</TableHead>
              <TableHead rowSpan={2}>{t('Status')}</TableHead>
              <TableHead colSpan={4} className='border-l text-center'>
                {t('Upstream Price')}
              </TableHead>
              <TableHead colSpan={4} className='border-l text-center'>
                {t('Our Price')}
              </TableHead>
              <TableHead colSpan={2} className='border-l text-center'>
                {t('Margin')}
              </TableHead>
            </TableRow>
            <TableRow>
              <TableHead className='border-l text-right'>
                {t('Input')}
              </TableHead>
              <TableHead className='text-right'>{t('Output')}</TableHead>
              <TableHead className='text-right'>{t('Cache Read')}</TableHead>
              <TableHead className='text-right'>{t('Cache Write')}</TableHead>
              <TableHead className='border-l text-right'>
                {t('Input')}
              </TableHead>
              <TableHead className='text-right'>{t('Output')}</TableHead>
              <TableHead className='text-right'>{t('Cache Read')}</TableHead>
              <TableHead className='text-right'>{t('Cache Write')}</TableHead>
              <TableHead className='border-l text-right'>
                {t('Input')}
              </TableHead>
              <TableHead className='text-right'>{t('Output')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {model.channels.map((channel) => (
              <ChannelRow key={channel.channel_id} channel={channel} />
            ))}
          </TableBody>
        </Table>
        </div>
      </CardContent>
    </Card>
  )
}
