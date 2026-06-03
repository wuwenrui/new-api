import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, TrendingUp, WalletCards } from 'lucide-react'
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
import {
  formatFinanceAmount,
  formatFinancePercent,
  getFinanceCurrencyConfig,
  startOfToday,
  addDays,
  toInputValue,
  toTimestamp,
} from './lib'

const METRIC_TONE = {
  revenue: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400',
  cost: 'bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-400',
  profit: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400',
  cash: 'bg-slate-50 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
} as const

function MetricCard({
  title,
  value,
  hint,
  tone,
}: {
  title: string
  value: string
  hint?: string
  tone: string
}) {
  return (
    <Card>
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
          <TableHead>{t('Model')}</TableHead>
          <TableHead className='w-20 text-right'>{t('Requests')}</TableHead>
          <TableHead className='text-right'>{t('Revenue')}</TableHead>
          <TableHead className='text-right'>{t('Cost')}</TableHead>
          <TableHead className='text-right'>{t('Profit')}</TableHead>
          <TableHead className='w-24 text-right'>{t('Margin')}</TableHead>
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
}: {
  rows: FinanceUserRow[]
  currency: ReturnType<typeof getFinanceCurrencyConfig>
}) {
  const { t } = useTranslation()
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('User')}</TableHead>
          <TableHead className='w-20 text-right'>{t('Requests')}</TableHead>
          <TableHead className='text-right'>{t('Revenue')}</TableHead>
          <TableHead className='text-right'>{t('Profit')}</TableHead>
          <TableHead className='w-24 text-right'>{t('Margin')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.username}>
            <TableCell className='font-medium'>{row.username}</TableCell>
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
  const today = useMemo(() => startOfToday(), [])
  const [startTime, setStartTime] = useState(toInputValue(addDays(today, -7)))
  const [endTime, setEndTime] = useState(toInputValue(addDays(today, 1)))
  const [report, setReport] = useState<FinanceReportData | null>(null)
  const [loading, setLoading] = useState(false)

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
    loadReport()
  }, [loadReport])

  const summary = report?.summary

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('Finance Report')}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <div className='flex flex-wrap items-center gap-2'>
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
            <div className='mb-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4'>
              <MetricCard
                title={t('Consumption Revenue')}
                value={formatFinanceAmount(
                  summary?.consumption_amount,
                  currency
                )}
                hint={`${summary?.requests ?? 0} ${t('requests')}`}
                tone={METRIC_TONE.revenue}
              />
              <MetricCard
                title={t('Estimated Upstream Cost')}
                value={formatFinanceAmount(
                  summary?.estimated_upstream_cost,
                  currency
                )}
                hint={t('Stripped by group ratio')}
                tone={METRIC_TONE.cost}
              />
              <MetricCard
                title={t('Gross Profit')}
                value={formatFinanceAmount(summary?.gross_profit, currency)}
                hint={formatFinancePercent(summary?.gross_margin)}
                tone={METRIC_TONE.profit}
              />
              <MetricCard
                title={t('Cash Income')}
                value={formatFinanceAmount(
                  summary?.cash_income_amount,
                  currency
                )}
                hint={`${t('Top-up')} ${formatFinanceAmount(summary?.cash_topup_amount, currency)} / ${t('Subscription')} ${formatFinanceAmount(summary?.cash_subscription_amount, currency)}`}
                tone={METRIC_TONE.cash}
              />
            </div>

            <div className='grid grid-cols-1 gap-4 xl:grid-cols-3'>
              <Card className='xl:col-span-2'>
                <CardHeader className='border-b'>
                  <CardTitle className='flex items-center gap-2'>
                    <WalletCards size={16} />
                    {t('Model Profit Ranking')}
                  </CardTitle>
                  <CardAction>
                    <Badge variant='secondary'>
                      {report?.models?.length ?? 0} {t('models')}
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className='p-0'>
                  <ModelTable
                    rows={report?.models ?? []}
                    currency={currency}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className='border-b'>
                  <CardTitle>{t('User Contribution Ranking')}</CardTitle>
                </CardHeader>
                <CardContent className='p-0'>
                  <UserTable rows={report?.users ?? []} currency={currency} />
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
