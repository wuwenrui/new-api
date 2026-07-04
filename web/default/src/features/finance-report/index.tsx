import { RefreshCw, TrendingUp, WalletCards } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardAction,
} from '@/components/ui/card'
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
  getFinanceReport,
  type FinanceModelRow,
  type FinanceUserRow,
  type FinanceReportData,
} from './api'
import { BalancesDrawer } from './drawers/balances-drawer'
import { OrdersDrawer } from './drawers/orders-drawer'
import { UserDetailDrawer } from './drawers/user-detail-drawer'
import {
  formatFinanceAmount,
  formatFinancePercent,
  type getFinanceCurrencyConfig,
  startOfToday,
  addDays,
  toInputValue,
  toTimestamp,
} from './lib'

const METRIC_TONE = {
  revenue:
    'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400',
  cost: 'bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-400',
  profit: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400',
  cash: 'bg-slate-50 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  refund: 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-400',
} as const

function MetricCard({
  title,
  value,
  hint,
  tone,
  onClick,
}: {
  title: string
  value: string
  hint?: string
  tone: string
  onClick?: () => void
}) {
  return (
    <Card
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      className={
        onClick
          ? 'hover:bg-accent/50 cursor-pointer transition-colors'
          : undefined
      }
    >
      <CardContent>
        <div className='flex items-start justify-between gap-3'>
          <div className='min-w-0'>
            <div className='text-muted-foreground text-sm'>{title}</div>
            <div className='mt-2 truncate text-2xl font-semibold tracking-normal'>
              {value}
            </div>
            {hint ? (
              <div className='text-muted-foreground mt-1 text-xs'>{hint}</div>
            ) : null}
          </div>
          <div className={`shrink-0 rounded-lg p-2 ${tone}`}>
            <TrendingUp size={18} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function ModelTable({
  rows,
  currency,
}: {
  rows: FinanceModelRow[]
  currency: ReturnType<typeof getFinanceCurrencyConfig>
}) {
  const { t } = useTranslation()
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('模型')}</TableHead>
          <TableHead className='w-20 text-right'>{t('请求数')}</TableHead>
          <TableHead className='text-right'>{t('实际使用')}</TableHead>
          <TableHead className='text-right'>{t('成本')}</TableHead>
          <TableHead className='text-right'>{t('实际赚到')}</TableHead>
          <TableHead className='w-24 text-right'>{t('利润率')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.model_name}>
            <TableCell className='font-medium'>{row.model_name}</TableCell>
            <TableCell className='text-right'>{row.requests}</TableCell>
            <TableCell className='text-right'>
              {formatFinanceAmount(row.consumption_amount, currency)}
            </TableCell>
            <TableCell className='text-right'>
              {formatFinanceAmount(row.estimated_upstream_cost, currency)}
            </TableCell>
            <TableCell className='text-right'>
              <span
                className={
                  Number(row.gross_profit) < 0
                    ? 'text-red-500'
                    : 'text-green-600'
                }
              >
                {formatFinanceAmount(row.gross_profit, currency)}
              </span>
            </TableCell>
            <TableCell className='text-right'>
              {formatFinancePercent(row.gross_margin)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function UserTable({
  rows,
  currency,
  onSelectUser,
}: {
  rows: FinanceUserRow[]
  currency: ReturnType<typeof getFinanceCurrencyConfig>
  onSelectUser: (username: string) => void
}) {
  const { t } = useTranslation()
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('用户')}</TableHead>
          <TableHead className='text-right'>{t('余额')}</TableHead>
          <TableHead className='text-right'>{t('累计充值')}</TableHead>
          <TableHead className='w-20 text-right'>{t('请求数')}</TableHead>
          <TableHead className='text-right'>{t('实际使用')}</TableHead>
          <TableHead className='text-right'>{t('实际赚到')}</TableHead>
          <TableHead className='w-24 text-right'>{t('利润率')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={row.username}
            className='cursor-pointer'
            onClick={() => onSelectUser(row.username)}
          >
            <TableCell className='font-medium'>{row.username}</TableCell>
            <TableCell className='text-right'>
              {formatFinanceAmount(row.balance, currency)}
            </TableCell>
            <TableCell className='text-right'>
              {formatFinanceAmount(row.total_topup, currency)}
            </TableCell>
            <TableCell className='text-right'>{row.requests}</TableCell>
            <TableCell className='text-right'>
              {formatFinanceAmount(row.consumption_amount, currency)}
            </TableCell>
            <TableCell className='text-right'>
              {formatFinanceAmount(row.gross_profit, currency)}
            </TableCell>
            <TableCell className='text-right'>
              {formatFinancePercent(row.gross_margin)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function FinanceReport() {
  const { t } = useTranslation()
  const currency = { symbol: '¥', rate: 1, type: 'CNY' }
  // 默认全部范围：空值 -> toTimestamp 返回 0 -> 后端不按时间过滤
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [report, setReport] = useState<FinanceReportData | null>(null)
  const [loading, setLoading] = useState(false)
  const [ordersOpen, setOrdersOpen] = useState(false)
  const [balancesOpen, setBalancesOpen] = useState(false)
  const [detailUser, setDetailUser] = useState<string | null>(null)
  const range = { start: toTimestamp(startTime), end: toTimestamp(endTime) }

  const setAllRange = useCallback(() => {
    setStartTime('')
    setEndTime('')
  }, [])

  const setLast7Days = useCallback(() => {
    const today = startOfToday()
    setStartTime(toInputValue(addDays(today, -7)))
    setEndTime(toInputValue(addDays(today, 1)))
  }, [])

  const loadReport = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getFinanceReport({
        start_timestamp: toTimestamp(startTime),
        end_timestamp: toTimestamp(endTime),
      })
      setReport(data)
    } finally {
      setLoading(false)
    }
  }, [startTime, endTime])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void loadReport()
    })
    return () => {
      cancelled = true
    }
  }, [loadReport])

  const summary = report?.summary

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('财务报表')}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <div className='flex flex-wrap items-center gap-2'>
          <Button variant='outline' size='sm' onClick={setAllRange}>
            {t('全部')}
          </Button>
          <Button variant='outline' size='sm' onClick={setLast7Days}>
            {t('近 7 天')}
          </Button>
          <input
            className='border-input bg-background h-8 rounded-md border px-2 text-sm'
            type='datetime-local'
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
          />
          <input
            className='border-input bg-background h-8 rounded-md border px-2 text-sm'
            type='datetime-local'
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
          />
          <Button variant='outline' onClick={loadReport} disabled={loading}>
            {loading ? <Spinner /> : <RefreshCw size={14} />}
            {t('Refresh')}
          </Button>
        </div>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        {loading && !report ? (
          <div className='flex items-center justify-center py-16'>
            <Spinner className='size-6' />
          </div>
        ) : (
          <>
            <div className='mb-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5'>
              <MetricCard
                title={t('实际使用')}
                value={formatFinanceAmount(
                  summary?.consumption_amount,
                  currency
                )}
                hint={`${summary?.requests ?? 0} ${t('次请求')}`}
                tone={METRIC_TONE.revenue}
              />
              <MetricCard
                title={t('预估上游成本')}
                value={formatFinanceAmount(
                  summary?.estimated_upstream_cost,
                  currency
                )}
                hint={t('按分组倍率折算')}
                tone={METRIC_TONE.cost}
              />
              <MetricCard
                title={t('实际赚到')}
                value={formatFinanceAmount(summary?.gross_profit, currency)}
                hint={`${t('实际使用扣上游成本')} · ${formatFinancePercent(summary?.gross_margin)}`}
                tone={METRIC_TONE.profit}
              />
              <MetricCard
                title={t('现金收入')}
                value={formatFinanceAmount(
                  summary?.cash_income_amount,
                  currency
                )}
                hint={`${t('充值')} ${formatFinanceAmount(summary?.cash_topup_amount, currency)} / ${t('订阅')} ${formatFinanceAmount(summary?.cash_subscription_amount, currency)}`}
                tone={METRIC_TONE.cash}
                onClick={() => setOrdersOpen(true)}
              />
              <MetricCard
                title={t('可能退款')}
                value={formatFinanceAmount(
                  summary?.user_balance_amount,
                  currency
                )}
                hint={t('全部用户当前余额（含赠送）')}
                tone={METRIC_TONE.refund}
                onClick={() => setBalancesOpen(true)}
              />
            </div>

            <div className='grid grid-cols-1 gap-4 xl:grid-cols-3'>
              <Card className='xl:col-span-2'>
                <CardHeader className='border-b'>
                  <CardTitle className='flex items-center gap-2'>
                    <WalletCards size={16} />
                    {t('模型利润排行')}
                  </CardTitle>
                  <CardAction>
                    <Badge variant='secondary'>
                      {report?.models?.length ?? 0} {t('个模型')}
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className='p-0'>
                  <ModelTable rows={report?.models ?? []} currency={currency} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className='border-b'>
                  <CardTitle>{t('用户贡献排行')}</CardTitle>
                  <span className='text-muted-foreground text-xs'>
                    {t('余额与累计充值为当前快照，与时间区间无关')}
                  </span>
                </CardHeader>
                <CardContent className='p-0'>
                  <UserTable
                    rows={report?.users ?? []}
                    currency={currency}
                    onSelectUser={setDetailUser}
                  />
                </CardContent>
              </Card>
            </div>
          </>
        )}
        <OrdersDrawer
          open={ordersOpen}
          onOpenChange={setOrdersOpen}
          range={range}
        />
        <BalancesDrawer
          open={balancesOpen}
          onOpenChange={setBalancesOpen}
          onSelectUser={(username) => {
            setBalancesOpen(false)
            setDetailUser(username)
          }}
        />
        <UserDetailDrawer
          username={detailUser}
          range={range}
          onOpenChange={(open) => {
            if (!open) setDetailUser(null)
          }}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
