import {
  AlertTriangle,
  Gauge,
  RefreshCw,
  TrendingUp,
  WalletCards,
} from 'lucide-react'
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
  getPACPriceMonitorReport,
  type FinanceModelRow,
  type FinanceUserRow,
  type FinanceReportData,
  type PACPriceMonitorData,
  type PACPriceMonitorRow,
} from './api'
import { BalancesDrawer } from './drawers/balances-drawer'
import { OrdersDrawer } from './drawers/orders-drawer'
import { UserDetailDrawer } from './drawers/user-detail-drawer'
import {
  formatFinanceAmount,
  formatFinancePercent,
  formatPACMonitorStatus,
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

function pacMonitorBadgeClass(status: PACPriceMonitorRow['status']): string {
  if (status === 'risk') {
    return 'bg-rose-50 text-rose-700 dark:bg-rose-950'
  }
  if (status === 'changed') {
    return 'bg-amber-50 text-amber-700 dark:bg-amber-950'
  }
  if (status === 'unknown') {
    return 'bg-slate-50 text-slate-700 dark:bg-slate-800'
  }
  return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950'
}

function PACMonitorTable({
  rows,
  currency,
}: {
  rows: PACPriceMonitorRow[]
  currency: ReturnType<typeof getFinanceCurrencyConfig>
}) {
  const { t } = useTranslation()
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('渠道')}</TableHead>
          <TableHead>{t('模型')}</TableHead>
          <TableHead>{t('状态')}</TableHead>
          <TableHead className='text-right'>{t('我方价')}</TableHead>
          <TableHead className='text-right'>{t('上游价')}</TableHead>
          <TableHead className='text-right'>{t('毛利率')}</TableHead>
          <TableHead className='text-right'>{t('区间收入')}</TableHead>
          <TableHead className='text-right'>{t('区间成本')}</TableHead>
          <TableHead className='text-right'>{t('区间盈利')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.channel_id}:${row.model_name}`}>
            <TableCell className='font-medium'>{row.channel_name}</TableCell>
            <TableCell>{row.model_name}</TableCell>
            <TableCell>
              <Badge className={pacMonitorBadgeClass(row.status)}>
                {formatPACMonitorStatus(row.status)}
              </Badge>
              {row.price_changed && row.status !== 'changed' ? (
                <Badge variant='outline' className='ml-1'>
                  {t('价格变更')}
                </Badge>
              ) : null}
            </TableCell>
            <TableCell className='text-right'>
              <div>
                {formatFinanceAmount(row.local_input_price, '$')} /{' '}
                {formatFinanceAmount(row.local_output_price, '$')}
              </div>
              {row.upstream_group ? (
                <div className='text-muted-foreground text-xs'>
                  {t('建议')}{' '}
                  {formatFinanceAmount(row.recommended_input_price, '$')} /{' '}
                  {formatFinanceAmount(row.recommended_output_price, '$')}
                </div>
              ) : null}
            </TableCell>
            <TableCell className='text-right'>
              {row.upstream_group ? (
                <>
                  {formatFinanceAmount(row.upstream_input_price, '$')} /{' '}
                  {formatFinanceAmount(row.upstream_output_price, '$')}
                </>
              ) : (
                '-'
              )}
            </TableCell>
            <TableCell className='text-right'>
              {formatFinancePercent(row.gross_margin)}
            </TableCell>
            <TableCell className='text-right'>
              {formatFinanceAmount(row.revenue, currency)}
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
  const [modelName, setModelName] = useState('')
  const [channelId, setChannelId] = useState('')
  const [report, setReport] = useState<FinanceReportData | null>(null)
  const [priceMonitor, setPriceMonitor] = useState<PACPriceMonitorData | null>(
    null
  )
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
      const params = {
        start_timestamp: toTimestamp(startTime),
        end_timestamp: toTimestamp(endTime),
        model_name: modelName.trim() || undefined,
        channel: Number(channelId) > 0 ? Number(channelId) : undefined,
      }
      const [data, monitorData] = await Promise.all([
        getFinanceReport(params),
        getPACPriceMonitorReport(params),
      ])
      setReport(data)
      setPriceMonitor(monitorData)
    } finally {
      setLoading(false)
    }
  }, [startTime, endTime, modelName, channelId])

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
  const monitorSummary = priceMonitor?.summary

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
          <input
            className='border-input bg-background h-8 w-40 rounded-md border px-2 text-sm'
            placeholder={t('模型名')}
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
          />
          <input
            className='border-input bg-background h-8 w-24 rounded-md border px-2 text-sm'
            min={1}
            placeholder={t('渠道 ID')}
            type='number'
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
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

            <Card className='mb-4'>
              <CardHeader className='border-b'>
                <CardTitle className='flex items-center gap-2'>
                  <Gauge size={16} />
                  {t('PAC 价格监控')}
                </CardTitle>
                <CardAction>
                  <Badge
                    variant={
                      (monitorSummary?.risk_models ?? 0) > 0 ||
                      (monitorSummary?.unknown_models ?? 0) > 0
                        ? 'destructive'
                        : 'secondary'
                    }
                  >
                    {monitorSummary?.checked_models ?? 0} {t('个模型')}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className='p-0'>
                <div className='grid grid-cols-2 border-b md:grid-cols-4'>
                  <div className='border-r p-4'>
                    <div className='text-muted-foreground text-xs'>
                      {t('价格变更')}
                    </div>
                    <div className='mt-1 text-xl font-semibold'>
                      {monitorSummary?.changed_prices ?? 0}
                    </div>
                  </div>
                  <div className='border-r p-4'>
                    <div className='text-muted-foreground text-xs'>
                      {t('低毛利')}
                    </div>
                    <div className='mt-1 flex items-center gap-2 text-xl font-semibold'>
                      {(monitorSummary?.risk_models ?? 0) > 0 ? (
                        <AlertTriangle className='text-destructive size-4' />
                      ) : null}
                      {monitorSummary?.risk_models ?? 0}
                    </div>
                  </div>
                  <div className='border-r p-4'>
                    <div className='text-muted-foreground text-xs'>
                      {t('未知价格')}
                    </div>
                    <div className='mt-1 text-xl font-semibold'>
                      {monitorSummary?.unknown_models ?? 0}
                    </div>
                  </div>
                  <div className='p-4'>
                    <div className='text-muted-foreground text-xs'>
                      {t('区间盈利')}
                    </div>
                    <div className='mt-1 text-xl font-semibold'>
                      {formatFinanceAmount(
                        monitorSummary?.gross_profit,
                        currency
                      )}
                    </div>
                  </div>
                </div>
                <PACMonitorTable
                  rows={priceMonitor?.rows ?? []}
                  currency={currency}
                />
              </CardContent>
            </Card>

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
