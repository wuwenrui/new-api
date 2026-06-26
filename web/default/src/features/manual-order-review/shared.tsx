import { ChevronLeft, ChevronRight, RefreshCw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Spinner } from '@/components/ui/spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatManualMoney } from './utils'

export const MANUAL_ORDER_PAGE_SIZE = 20

export type ManualOrderTab = 'pending' | 'history' | 'analysis'

export type ManualOrderBreakdown = {
  status?: string
  payment_method?: string
  count: number
  money: number
}

export type ManualOrderSummaryLike = {
  total_count: number
  pending_count: number
  success_count: number
  failed_count: number
  expired_count: number
  total_money: number
  pending_money: number
  success_money: number
  failed_money: number
  expired_money: number
  by_status: ManualOrderBreakdown[]
  by_method: ManualOrderBreakdown[]
}

export function ManualOrderFilters({
  keyword,
  status,
  startTime,
  endTime,
  loading,
  onKeywordChange,
  onStatusChange,
  onStartTimeChange,
  onEndTimeChange,
  onApply,
  onReset,
}: {
  keyword: string
  status: string
  startTime: string
  endTime: string
  loading: boolean
  onKeywordChange: (value: string) => void
  onStatusChange: (value: string) => void
  onStartTimeChange: (value: string) => void
  onEndTimeChange: (value: string) => void
  onApply: () => void
  onReset: () => void
}) {
  return (
    <div className='flex flex-wrap items-center gap-2'>
      <Input
        className='h-8 w-56'
        value={keyword}
        onChange={(event) => onKeywordChange(event.target.value)}
        placeholder='订单号 / 用户 / ID'
      />
      <NativeSelect
        size='sm'
        value={status}
        onChange={(event) => onStatusChange(event.target.value)}
      >
        <NativeSelectOption value='all'>全部状态</NativeSelectOption>
        <NativeSelectOption value='pending'>待确认</NativeSelectOption>
        <NativeSelectOption value='success'>已确认</NativeSelectOption>
        <NativeSelectOption value='failed'>失败</NativeSelectOption>
        <NativeSelectOption value='expired'>已过期</NativeSelectOption>
      </NativeSelect>
      <Input
        className='h-8 w-44'
        type='datetime-local'
        value={startTime}
        onChange={(event) => onStartTimeChange(event.target.value)}
      />
      <Input
        className='h-8 w-44'
        type='datetime-local'
        value={endTime}
        onChange={(event) => onEndTimeChange(event.target.value)}
      />
      <Button size='sm' variant='outline' onClick={onApply} disabled={loading}>
        {loading ? <Spinner /> : <Search size={14} />}
        查询
      </Button>
      <Button size='icon' variant='ghost' onClick={onReset} disabled={loading}>
        <X size={14} />
      </Button>
    </div>
  )
}

export function ManualOrderSummaryCards({
  summary,
  loading,
}: {
  summary: ManualOrderSummaryLike
  loading: boolean
}) {
  const cards = [
    { label: '订单数', value: String(summary.total_count) },
    { label: '待确认', value: String(summary.pending_count) },
    { label: '已确认', value: String(summary.success_count) },
    { label: '总金额', value: formatManualMoney(summary.total_money) },
    { label: '确认金额', value: formatManualMoney(summary.success_money) },
  ]

  return (
    <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5'>
      {cards.map((card) => (
        <Card key={card.label} size='sm'>
          <CardContent>
            <div className='text-muted-foreground text-xs'>{card.label}</div>
            <div className='mt-1 text-xl font-semibold tracking-normal'>
              {loading ? '-' : card.value}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export function ManualOrderBreakdownTable({
  title,
  rows,
  getLabel,
}: {
  title: string
  rows: ManualOrderBreakdown[]
  getLabel: (row: ManualOrderBreakdown) => string
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>维度</TableHead>
              <TableHead className='text-right'>订单数</TableHead>
              <TableHead className='text-right'>金额</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  className='text-muted-foreground py-8 text-center'
                  colSpan={3}
                >
                  暂无数据
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={`${row.status ?? ''}-${row.payment_method ?? ''}`}
                >
                  <TableCell className='font-medium'>{getLabel(row)}</TableCell>
                  <TableCell className='text-right'>{row.count}</TableCell>
                  <TableCell className='text-right'>
                    {formatManualMoney(row.money)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export function ManualOrderPager({
  page,
  total,
  loading,
  onPageChange,
}: {
  page: number
  total: number
  loading: boolean
  onPageChange: (page: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(total / MANUAL_ORDER_PAGE_SIZE))
  return (
    <div className='text-muted-foreground flex items-center justify-end gap-2 text-sm'>
      <span>
        {page} / {totalPages}
      </span>
      <Button
        size='icon'
        variant='outline'
        disabled={loading || page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        <ChevronLeft size={14} />
      </Button>
      <Button
        size='icon'
        variant='outline'
        disabled={loading || page >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        <ChevronRight size={14} />
      </Button>
      <Button
        size='icon'
        variant='outline'
        disabled={loading}
        onClick={() => onPageChange(page)}
      >
        {loading ? <Spinner /> : <RefreshCw size={14} />}
      </Button>
    </div>
  )
}
