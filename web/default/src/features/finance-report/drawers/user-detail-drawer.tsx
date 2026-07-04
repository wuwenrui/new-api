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
  getFinanceBalances,
  getFinanceReport,
  getFinanceTopUps,
  type FinanceBalanceRow,
  type FinanceOrderRow,
  type FinanceReportData,
} from '../api'
import {
  formatFinanceAmount,
  formatFinancePercent,
  formatGiftedEstimate,
} from '../lib'

function StatBlock({ title, value }: { title: string; value: string }) {
  return (
    <div className='border-border/70 rounded-lg border p-3'>
      <div className='text-muted-foreground text-xs'>{title}</div>
      <div className='mt-1 truncate text-lg font-semibold'>{value}</div>
    </div>
  )
}

export function UserDetailDrawer({
  username,
  range,
  onOpenChange,
}: {
  username: string | null
  range: { start: number; end: number }
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [balanceRow, setBalanceRow] = useState<FinanceBalanceRow | null>(null)
  const [report, setReport] = useState<FinanceReportData | null>(null)
  const [topUps, setTopUps] = useState<FinanceOrderRow[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!username) return
    let cancelled = false
    async function load(name: string) {
      setLoading(true)
      try {
        const [balances, reportData, topUpPage] = await Promise.all([
          getFinanceBalances(),
          getFinanceReport({
            start_timestamp: range.start,
            end_timestamp: range.end,
            username: name,
          }),
          getFinanceTopUps({
            start_timestamp: 0,
            end_timestamp: 0,
            username: name,
            size: 50,
          }),
        ])
        if (cancelled) return
        setBalanceRow(balances?.find((row) => row.username === name) ?? null)
        setReport(reportData)
        setTopUps(topUpPage?.items ?? [])
      } catch {
        if (cancelled) return
        setBalanceRow(null)
        setReport(null)
        setTopUps([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load(username)
    return () => {
      cancelled = true
    }
  }, [username, range.start, range.end])

  const models = report?.models ?? []

  return (
    <Sheet open={username !== null} onOpenChange={onOpenChange}>
      <SheetContent className={sideDrawerContentClassName('sm:max-w-3xl')}>
        <SheetHeader className={sideDrawerHeaderClassName()}>
          <SheetTitle>
            {t('用户详情')} · {username ?? '-'}
          </SheetTitle>
        </SheetHeader>
        <div className={sideDrawerFormClassName()}>
          {loading ? (
            <div className='flex items-center justify-center py-12'>
              <Spinner className='size-6' />
            </div>
          ) : (
            <>
              <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
                <StatBlock
                  title={t('当前余额')}
                  value={formatFinanceAmount(balanceRow?.balance, '¥')}
                />
                <StatBlock
                  title={t('累计充值')}
                  value={formatFinanceAmount(balanceRow?.total_topup, '¥')}
                />
                <StatBlock
                  title={t('累计消费')}
                  value={formatFinanceAmount(balanceRow?.total_consumed, '¥')}
                />
                <StatBlock
                  title={t('赠送估算')}
                  value={formatGiftedEstimate(balanceRow?.gifted_estimate, '¥')}
                />
              </div>

              <section className='flex flex-col gap-2'>
                <h3 className='flex items-center gap-2 text-sm font-semibold'>
                  {t('区间内按模型消耗')}
                  <Badge variant='secondary'>{models.length}</Badge>
                </h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('模型')}</TableHead>
                      <TableHead className='text-right'>
                        {t('请求数')}
                      </TableHead>
                      <TableHead className='text-right'>
                        {t('实际使用')}
                      </TableHead>
                      <TableHead className='text-right'>
                        {t('实际赚到')}
                      </TableHead>
                      <TableHead className='text-right'>
                        {t('利润率')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {models.map((row) => (
                      <TableRow key={row.model_name}>
                        <TableCell className='font-medium'>
                          {row.model_name}
                        </TableCell>
                        <TableCell className='text-right'>
                          {row.requests}
                        </TableCell>
                        <TableCell className='text-right'>
                          {formatFinanceAmount(row.consumption_amount, '¥')}
                        </TableCell>
                        <TableCell className='text-right'>
                          {formatFinanceAmount(row.gross_profit, '¥')}
                        </TableCell>
                        <TableCell className='text-right'>
                          {formatFinancePercent(row.gross_margin)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>

              <section className='flex flex-col gap-2'>
                <h3 className='text-sm font-semibold'>
                  {t('充值订单（全部时间，最近 50 笔）')}
                </h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('时间')}</TableHead>
                      <TableHead className='text-right'>{t('金额')}</TableHead>
                      <TableHead>{t('支付方式')}</TableHead>
                      <TableHead>{t('状态')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topUps.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className='whitespace-nowrap'>
                          {(row.complete_time || row.create_time)
                            ? new Date(
                                (row.complete_time || row.create_time) * 1000
                              ).toLocaleString()
                            : '-'}
                        </TableCell>
                        <TableCell className='text-right'>
                          {formatFinanceAmount(row.money, '¥')}
                        </TableCell>
                        <TableCell>{row.payment_method || '-'}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              row.status === 'success'
                                ? 'secondary'
                                : 'outline'
                            }
                          >
                            {row.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
