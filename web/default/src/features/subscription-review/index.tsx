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
import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { formatNumber, formatTimestampToDate } from '@/lib/format'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SectionPageLayout } from '@/components/layout'
import { StatusBadge } from '@/components/status-badge'
import {
  MANUAL_ORDER_PAGE_SIZE,
  ManualOrderBreakdownTable,
  ManualOrderFilters,
  ManualOrderPager,
  ManualOrderSummaryCards,
  type ManualOrderTab,
} from '@/features/manual-order-review/shared'
import {
  formatManualMoney,
  formatManualTime,
  statusLabel,
  statusVariant,
  toTimestamp,
} from '@/features/manual-order-review/utils'
import {
  completeManualSubscription,
  getManualSubscriptionOrders,
  getPendingManualSubscriptions,
  isApiSuccess,
} from './api'
import { findOrderIndexByTradeNo, normalizeManualOrderSummary } from './lib'
import type { ManualOrderSummary, PendingManualSubscription } from './types'

const PAGE_SIZE = 100

function ConfirmDialog({
  target,
  submitting,
  onCancel,
  onConfirm,
}: {
  target: PendingManualSubscription | null
  submitting: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('确认开通订阅')}</DialogTitle>
          <DialogDescription>
            {t('确认后将为该用户开通对应订阅权益。')}
          </DialogDescription>
        </DialogHeader>
        {target ? (
          <div className='space-y-2 text-sm'>
            <div>
              {t('用户')}: {target.username || target.email}
              {' (ID: '}
              {target.user_id})
            </div>
            <div>
              {t('套餐')}: {target.plan_title}
            </div>
            <div className='font-mono'>
              {t('订单号')}: {target.trade_no}
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <DialogClose
            render={<Button variant='outline' disabled={submitting} />}
          >
            {t('取消')}
          </DialogClose>
          <Button onClick={onConfirm} disabled={submitting || !target}>
            {submitting ? <Spinner /> : null}
            {t('确认开通')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SubscriptionReview({ tradeNo }: { tradeNo?: string }) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<ManualOrderTab>('pending')
  const [orders, setOrders] = useState<PendingManualSubscription[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [confirmTarget, setConfirmTarget] =
    useState<PendingManualSubscription | null>(null)
  const [highlightTradeNo, setHighlightTradeNo] = useState<string | null>(null)
  const [historyOrders, setHistoryOrders] = useState<
    PendingManualSubscription[]
  >([])
  const [historyTotal, setHistoryTotal] = useState(0)
  const [historySummary, setHistorySummary] = useState<ManualOrderSummary>(
    normalizeManualOrderSummary(undefined)
  )
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyPage, setHistoryPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState('all')
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const focusedTradeNo = useRef<string | null>(null)

  const loadOrders = useCallback(async () => {
    setLoading(true)
    try {
      const response = await getPendingManualSubscriptions(1, PAGE_SIZE)
      if (isApiSuccess(response) && response.data) {
        setOrders(response.data.items || [])
      } else {
        toast.error(response.message || t('加载待确认订阅失败'))
        setOrders([])
      }
    } catch {
      toast.error(t('加载待确认订阅失败'))
      setOrders([])
    } finally {
      setLoading(false)
    }
  }, [t])

  const loadHistory = useCallback(
    async (page = historyPage) => {
      setHistoryLoading(true)
      try {
        const response = await getManualSubscriptionOrders({
          page,
          pageSize: MANUAL_ORDER_PAGE_SIZE,
          keyword,
          status,
          startTimestamp: toTimestamp(startTime),
          endTimestamp: toTimestamp(endTime),
        })
        if (isApiSuccess(response) && response.data) {
          setHistoryOrders(response.data.items || [])
          setHistoryTotal(response.data.total || 0)
          setHistorySummary(normalizeManualOrderSummary(response.data.summary))
          setHistoryPage(page)
        } else {
          toast.error(response.message || t('加载订阅列表失败'))
          setHistoryOrders([])
          setHistoryTotal(0)
          setHistorySummary(normalizeManualOrderSummary(undefined))
        }
      } catch {
        toast.error(t('加载订阅列表失败'))
        setHistoryOrders([])
        setHistoryTotal(0)
        setHistorySummary(normalizeManualOrderSummary(undefined))
      } finally {
        setHistoryLoading(false)
      }
    },
    [endTime, historyPage, keyword, startTime, status, t]
  )

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void loadOrders()
    })
    return () => {
      cancelled = true
    }
  }, [loadOrders])

  useEffect(() => {
    if (activeTab === 'pending') return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void loadHistory(historyPage)
    })
    return () => {
      cancelled = true
    }
  }, [activeTab, historyPage, loadHistory])

  useEffect(() => {
    if (!tradeNo) return
    if (focusedTradeNo.current === tradeNo) return
    const index = findOrderIndexByTradeNo(orders, tradeNo)
    if (index < 0) return
    focusedTradeNo.current = tradeNo
    queueMicrotask(() => {
      setHighlightTradeNo(tradeNo)
      rowRefs.current[tradeNo]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
      setConfirmTarget(orders[index])
    })
  }, [tradeNo, orders])

  const handleConfirm = useCallback(async () => {
    if (!confirmTarget) return
    setSubmitting(true)
    try {
      const response = await completeManualSubscription(confirmTarget.trade_no)
      if (isApiSuccess(response)) {
        toast.success(t('订阅已开通'))
        setConfirmTarget(null)
        await loadOrders()
      } else {
        toast.error(response.message || t('开通订阅失败'))
      }
    } catch {
      toast.error(t('开通订阅失败'))
    } finally {
      setSubmitting(false)
    }
  }, [confirmTarget, loadOrders, t])

  const applyHistoryFilters = useCallback(() => {
    if (historyPage === 1) void loadHistory(1)
    else setHistoryPage(1)
  }, [historyPage, loadHistory])

  const resetHistoryFilters = useCallback(() => {
    setKeyword('')
    setStatus('all')
    setStartTime('')
    setEndTime('')
    setHistoryPage(1)
  }, [])

  return (
    <>
      <SectionPageLayout>
        <SectionPageLayout.Title>{t('待确认订阅')}</SectionPageLayout.Title>
        <SectionPageLayout.Content>
          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as ManualOrderTab)}
          >
            <TabsList className='mb-4 max-w-full flex-wrap justify-start group-data-horizontal/tabs:h-auto'>
              <TabsTrigger value='pending'>{t('待确认')}</TabsTrigger>
              <TabsTrigger value='history'>{t('订阅列表')}</TabsTrigger>
              <TabsTrigger value='analysis'>{t('统计分析')}</TabsTrigger>
            </TabsList>

            <TabsContent value='pending'>
              <div className='mb-3 flex justify-end'>
                <Button
                  variant='outline'
                  onClick={loadOrders}
                  disabled={loading}
                >
                  {loading ? <Spinner /> : <RefreshCw size={14} />}
                  {t('Refresh')}
                </Button>
              </div>
              {loading && orders.length === 0 ? (
                <div className='flex items-center justify-center py-16'>
                  <Spinner className='size-6' />
                </div>
              ) : orders.length === 0 ? (
                <div className='text-muted-foreground flex min-h-40 flex-col items-center justify-center py-10 text-center'>
                  <p className='text-sm font-medium'>{t('暂无待确认订阅')}</p>
                  <p className='mt-1 text-xs'>
                    {t('用户提交人工订阅后会显示在这里')}
                  </p>
                </div>
              ) : (
                <ScrollArea className='max-h-[calc(100dvh-14rem)] pr-3 sm:pr-4'>
                  <div className='space-y-3'>
                    {orders.map((order) => {
                      const highlighted = highlightTradeNo === order.trade_no
                      return (
                        <div
                          key={order.id}
                          ref={(node) => {
                            rowRefs.current[order.trade_no] = node
                          }}
                          className={
                            highlighted
                              ? 'ring-primary bg-muted/40 rounded-lg border p-3 ring-2 transition-colors sm:p-4'
                              : 'hover:bg-muted/50 rounded-lg border p-3 transition-colors sm:p-4'
                          }
                        >
                          <div className='flex items-start justify-between gap-2'>
                            <div className='min-w-0 flex-1 space-y-1'>
                              <div className='flex min-w-0 flex-wrap items-center gap-2'>
                                <span className='text-sm font-medium'>
                                  {order.username || order.email}
                                </span>
                                <StatusBadge
                                  label={`${t('User ID')}: ${order.user_id}`}
                                  variant='neutral'
                                  size='sm'
                                  copyText={String(order.user_id)}
                                />
                              </div>
                              <div className='text-muted-foreground text-xs'>
                                {formatTimestampToDate(order.create_time)}
                              </div>
                              <code className='text-muted-foreground block truncate font-mono text-xs'>
                                {order.trade_no}
                              </code>
                            </div>
                            <StatusBadge
                              label={t('Pending')}
                              variant='warning'
                              showDot
                              copyable={false}
                            />
                          </div>

                          <div className='mt-3 grid grid-cols-2 gap-3 sm:mt-4 sm:grid-cols-3 sm:gap-4'>
                            <div className='space-y-1'>
                              <Label className='text-muted-foreground text-xs'>
                                {t('套餐')}
                              </Label>
                              <div className='text-sm font-semibold'>
                                {order.plan_title}
                              </div>
                            </div>
                            <div className='space-y-1'>
                              <Label className='text-muted-foreground text-xs'>
                                {t('应收')}
                              </Label>
                              <div className='text-sm font-semibold text-red-600'>
                                {`¥${formatNumber(order.money)}`}
                              </div>
                            </div>
                            <div className='space-y-1'>
                              <Label className='text-muted-foreground text-xs'>
                                {t('方式')}
                              </Label>
                              <div className='text-sm font-medium'>
                                {order.payment_method}
                              </div>
                            </div>
                          </div>

                          <div className='mt-4 flex justify-end'>
                            <Button
                              size='sm'
                              variant='outline'
                              onClick={() => setConfirmTarget(order)}
                              disabled={submitting}
                            >
                              {t('确认开通')}
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </ScrollArea>
              )}
            </TabsContent>

            <TabsContent value='history' className='space-y-3'>
              <ManualOrderFilters
                keyword={keyword}
                status={status}
                startTime={startTime}
                endTime={endTime}
                loading={historyLoading}
                onKeywordChange={setKeyword}
                onStatusChange={setStatus}
                onStartTimeChange={setStartTime}
                onEndTimeChange={setEndTime}
                onApply={applyHistoryFilters}
                onReset={resetHistoryFilters}
              />
              {historyLoading && historyOrders.length === 0 ? (
                <div className='flex items-center justify-center py-16'>
                  <Spinner className='size-6' />
                </div>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('用户')}</TableHead>
                        <TableHead>{t('套餐')}</TableHead>
                        <TableHead>{t('订单号')}</TableHead>
                        <TableHead>{t('创建时间')}</TableHead>
                        <TableHead>{t('完成时间')}</TableHead>
                        <TableHead className='text-right'>
                          {t('应收')}
                        </TableHead>
                        <TableHead>{t('方式')}</TableHead>
                        <TableHead>{t('状态')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {historyOrders.length === 0 ? (
                        <TableRow>
                          <TableCell
                            className='text-muted-foreground py-10 text-center'
                            colSpan={8}
                          >
                            {t('暂无订阅记录')}
                          </TableCell>
                        </TableRow>
                      ) : (
                        historyOrders.map((order) => (
                          <TableRow key={order.id}>
                            <TableCell>
                              <div className='font-medium'>
                                {order.username || order.email || '-'}
                              </div>
                              <div className='text-muted-foreground text-xs'>
                                ID: {order.user_id}
                              </div>
                            </TableCell>
                            <TableCell className='font-medium'>
                              {order.plan_title}
                            </TableCell>
                            <TableCell className='font-mono text-xs'>
                              {order.trade_no}
                            </TableCell>
                            <TableCell>
                              {formatManualTime(order.create_time)}
                            </TableCell>
                            <TableCell>
                              {formatManualTime(order.complete_time)}
                            </TableCell>
                            <TableCell className='text-right font-medium text-red-600'>
                              {formatManualMoney(order.money)}
                            </TableCell>
                            <TableCell>{order.payment_method}</TableCell>
                            <TableCell>
                              <StatusBadge
                                label={statusLabel(order.status, t)}
                                variant={statusVariant(order.status)}
                                copyable={false}
                              />
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                  <ManualOrderPager
                    page={historyPage}
                    total={historyTotal}
                    loading={historyLoading}
                    onPageChange={setHistoryPage}
                  />
                </>
              )}
            </TabsContent>

            <TabsContent value='analysis' className='space-y-4'>
              <ManualOrderFilters
                keyword={keyword}
                status={status}
                startTime={startTime}
                endTime={endTime}
                loading={historyLoading}
                onKeywordChange={setKeyword}
                onStatusChange={setStatus}
                onStartTimeChange={setStartTime}
                onEndTimeChange={setEndTime}
                onApply={applyHistoryFilters}
                onReset={resetHistoryFilters}
              />
              <ManualOrderSummaryCards
                summary={historySummary}
                loading={historyLoading}
              />
              <div className='grid grid-cols-1 gap-4 xl:grid-cols-2'>
                <ManualOrderBreakdownTable
                  title={t('按状态')}
                  rows={historySummary.by_status}
                  getLabel={(row) => statusLabel(row.status || '', t)}
                />
                <ManualOrderBreakdownTable
                  title={t('按方式')}
                  rows={historySummary.by_method}
                  getLabel={(row) => row.payment_method || '-'}
                />
              </div>
            </TabsContent>
          </Tabs>
        </SectionPageLayout.Content>
      </SectionPageLayout>

      <ConfirmDialog
        target={confirmTarget}
        submitting={submitting}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={handleConfirm}
      />
    </>
  )
}
