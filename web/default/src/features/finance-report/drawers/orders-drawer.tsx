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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  sideDrawerContentClassName,
  sideDrawerFormClassName,
  sideDrawerHeaderClassName,
} from '@/components/drawer-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  getFinanceSubscriptionOrders,
  getFinanceTopUps,
  type FinanceOrderPage,
} from '../api'
import { formatFinanceAmount } from '../lib'

const PAGE_SIZE = 20

type OrderKind = 'topup' | 'subscription'
type OrderStatus = 'success' | 'all'

function formatOrderTime(row: { complete_time: number; create_time: number }) {
  const ts = row.complete_time || row.create_time
  if (!ts) return '-'
  return new Date(ts * 1000).toLocaleString()
}

function OrderTable({
  kind,
  range,
}: {
  kind: OrderKind
  range: { start: number; end: number }
}) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<OrderStatus>('success')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<FinanceOrderPage | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    const fetcher =
      kind === 'topup' ? getFinanceTopUps : getFinanceSubscriptionOrders
    async function load() {
      setLoading(true)
      try {
        const result = await fetcher({
          start_timestamp: range.start,
          end_timestamp: range.end,
          status,
          p: page,
          size: PAGE_SIZE,
        })
        if (!cancelled) setData(result)
      } catch {
        if (!cancelled) setData(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [kind, range.start, range.end, status, page])

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const switchStatus = (next: OrderStatus) => {
    if (next === status) return
    setStatus(next)
    setPage(1)
  }

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          variant={status === 'success' ? 'default' : 'outline'}
          size='sm'
          onClick={() => switchStatus('success')}
        >
          {t('仅成功')}
        </Button>
        <Button
          variant={status === 'all' ? 'default' : 'outline'}
          size='sm'
          onClick={() => switchStatus('all')}
        >
          {t('全部状态')}
        </Button>
        <Badge variant='secondary'>
          {total} {t('笔')}
        </Badge>
      </div>

      {loading ? (
        <div className='flex items-center justify-center py-12'>
          <Spinner className='size-6' />
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('时间')}</TableHead>
              <TableHead>{t('用户')}</TableHead>
              <TableHead className='text-right'>{t('金额')}</TableHead>
              <TableHead>{t('支付方式')}</TableHead>
              <TableHead>{t('状态')}</TableHead>
              <TableHead>{t('订单号')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((row) => (
              <TableRow key={row.id}>
                <TableCell className='whitespace-nowrap'>
                  {formatOrderTime(row)}
                </TableCell>
                <TableCell className='font-medium'>{row.username}</TableCell>
                <TableCell className='text-right'>
                  {formatFinanceAmount(row.money, '¥')}
                </TableCell>
                <TableCell>{row.payment_method || '-'}</TableCell>
                <TableCell>
                  <Badge
                    variant={row.status === 'success' ? 'secondary' : 'outline'}
                  >
                    {row.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <span className='text-muted-foreground block max-w-40 truncate text-xs'>
                    {row.trade_no || '-'}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {pageCount > 1 ? (
        <div className='flex items-center justify-end gap-2'>
          <Button
            variant='outline'
            size='sm'
            disabled={page <= 1 || loading}
            onClick={() => setPage(page - 1)}
          >
            {t('上一页')}
          </Button>
          <span className='text-muted-foreground text-sm'>
            {page} / {pageCount}
          </span>
          <Button
            variant='outline'
            size='sm'
            disabled={page >= pageCount || loading}
            onClick={() => setPage(page + 1)}
          >
            {t('下一页')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function OrdersDrawer({
  open,
  onOpenChange,
  range,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  range: { start: number; end: number }
}) {
  const { t } = useTranslation()
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className={sideDrawerContentClassName('sm:max-w-3xl')}>
        <SheetHeader className={sideDrawerHeaderClassName()}>
          <SheetTitle>{t('现金收入明细')}</SheetTitle>
        </SheetHeader>
        <div className={sideDrawerFormClassName()}>
          <Tabs defaultValue='topup'>
            <TabsList>
              <TabsTrigger value='topup'>{t('充值订单')}</TabsTrigger>
              <TabsTrigger value='subscription'>{t('订阅订单')}</TabsTrigger>
            </TabsList>
            <TabsContent value='topup'>
              <OrderTable kind='topup' range={range} />
            </TabsContent>
            <TabsContent value='subscription'>
              <OrderTable kind='subscription' range={range} />
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  )
}
