import { RefreshCw } from 'lucide-react'
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { SectionPageLayout } from '@/components/layout'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
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
import { formatNumber, formatTimestampToDate } from '@/lib/format'

import {
  completeOrderWithAmount,
  confirmManualTopUpStatus,
  getManualTopUpOrders,
  getPendingManualTopUps,
  isApiSuccess,
} from './api'
import {
  findOrderIndexByTradeNo,
  normalizeManualOrderSummary,
  previewQuota,
} from './lib'
import type { ManualOrderSummary, PendingManualTopUp } from './types'

const PAGE_SIZE = 100

type ConfirmTarget = {
  order: PendingManualTopUp
  amount: string
}

function ConfirmDialog({
  target,
  submitting,
  onAmountChange,
  onCancel,
  onConfirm,
}: {
  target: ConfirmTarget | null
  submitting: boolean
  onAmountChange: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  const open = target !== null
  const parsedAmount = target ? Number(target.amount) : 0
  const validAmount = Number.isFinite(parsedAmount) && parsedAmount > 0

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('确认充值')}</DialogTitle>
          <DialogDescription>
            {t('确认后将为该用户充值并入账，请核对到账金额。')}
          </DialogDescription>
        </DialogHeader>
        {target ? (
          <div className='space-y-3'>
            <div className='text-muted-foreground space-y-1 text-xs'>
              <div>
                {t('用户')}: {target.order.username || target.order.email}
                {' (ID: '}
                {target.order.user_id})
              </div>
              <div className='font-mono'>
                {t('订单号')}: {target.order.trade_no}
              </div>
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='recharge-review-amount'>{t('充值额度')}</Label>
              <Input
                id='recharge-review-amount'
                type='number'
                min={1}
                step={1}
                value={target.amount}
                onChange={(e) => onAmountChange(e.target.value)}
              />
              <div className='text-muted-foreground text-xs'>
                {t('将给用户充值')} = {previewQuota(parsedAmount)}
              </div>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <DialogClose
            render={<Button variant='outline' disabled={submitting} />}
          >
            {t('取消')}
          </DialogClose>
          <Button onClick={onConfirm} disabled={submitting || !validAmount}>
            {submitting ? <Spinner /> : null}
            {t('确认充值')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BatchConfirmDialog({
  open,
  count,
  submitting,
  onCancel,
  onConfirm,
}: {
  open: boolean
  count: number
  submitting: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('批量确认状态（不充值）')}</DialogTitle>
          <DialogDescription>
            {t('将所选订单标记为已完成，仅改状态、不会给用户充值。')}
          </DialogDescription>
        </DialogHeader>
        <div className='text-sm'>
          {t('已选择')}: <span className='font-semibold'>{count}</span>
        </div>
        <DialogFooter>
          <DialogClose
            render={<Button variant='outline' disabled={submitting} />}
          >
            {t('取消')}
          </DialogClose>
          <Button onClick={onConfirm} disabled={submitting || count === 0}>
            {submitting ? <Spinner /> : null}
            {t('确认状态')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RechargeReview({ tradeNo }: { tradeNo?: string }) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<ManualOrderTab>('pending')
  const [orders, setOrders] = useState<PendingManualTopUp[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null)
  const [highlightTradeNo, setHighlightTradeNo] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchSubmitting, setBatchSubmitting] = useState(false)
  const [historyOrders, setHistoryOrders] = useState<PendingManualTopUp[]>([])
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
      const response = await getPendingManualTopUps(1, PAGE_SIZE)
      if (isApiSuccess(response) && response.data) {
        setOrders(response.data.items || [])
      } else {
        toast.error(response.message || t('加载待确认充值失败'))
        setOrders([])
      }
    } catch {
      toast.error(t('加载待确认充值失败'))
      setOrders([])
    } finally {
      setSelected(new Set())
      setLoading(false)
    }
  }, [t])

  const loadHistory = useCallback(
    async (page = historyPage) => {
      setHistoryLoading(true)
      try {
        const response = await getManualTopUpOrders({
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
          toast.error(response.message || t('加载充值列表失败'))
          setHistoryOrders([])
          setHistoryTotal(0)
          setHistorySummary(normalizeManualOrderSummary(undefined))
        }
      } catch {
        toast.error(t('加载充值列表失败'))
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

  const openConfirm = useCallback((order: PendingManualTopUp) => {
    setConfirmTarget({ order, amount: String(order.amount) })
  }, [])

  // Auto-locate the order referenced by the deep link: scroll into view,
  // highlight it, and open its confirm dialog exactly once per trade_no.
  useEffect(() => {
    if (!tradeNo) return
    if (focusedTradeNo.current === tradeNo) return
    const index = findOrderIndexByTradeNo(orders, tradeNo)
    if (index < 0) return
    focusedTradeNo.current = tradeNo
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setHighlightTradeNo(tradeNo)
      const node = rowRefs.current[tradeNo]
      if (node) {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      openConfirm(orders[index])
    })
    return () => {
      cancelled = true
    }
  }, [tradeNo, orders, openConfirm])

  const handleAmountChange = useCallback((value: string) => {
    setConfirmTarget((prev) => (prev ? { ...prev, amount: value } : prev))
  }, [])

  const handleConfirm = useCallback(async () => {
    if (!confirmTarget) return
    const amount = Math.trunc(Number(confirmTarget.amount))
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(t('无效的充值额度'))
      return
    }
    setSubmitting(true)
    try {
      const response = await completeOrderWithAmount({
        trade_no: confirmTarget.order.trade_no,
        amount,
      })
      if (isApiSuccess(response)) {
        toast.success(t('充值成功'))
        setConfirmTarget(null)
        await loadOrders()
      } else {
        toast.error(response.message || t('充值失败'))
      }
    } catch {
      toast.error(t('充值失败'))
    } finally {
      setSubmitting(false)
    }
  }, [confirmTarget, loadOrders, t])

  const toggleSelect = useCallback((tradeNoValue: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(tradeNoValue)) next.delete(tradeNoValue)
      else next.add(tradeNoValue)
      return next
    })
  }, [])

  const allSelected = useMemo(
    () => orders.length > 0 && orders.every((o) => selected.has(o.trade_no)),
    [orders, selected]
  )

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      if (orders.length > 0 && orders.every((o) => prev.has(o.trade_no))) {
        return new Set()
      }
      return new Set(orders.map((o) => o.trade_no))
    })
  }, [orders])

  const handleBatchConfirm = useCallback(async () => {
    const tradeNos = [...selected]
    if (tradeNos.length === 0) return
    setBatchSubmitting(true)
    try {
      const response = await confirmManualTopUpStatus({ trade_nos: tradeNos })
      if (isApiSuccess(response)) {
        toast.success(
          `${t('确认状态成功')}: ${response.data?.count ?? tradeNos.length}`
        )
        setBatchOpen(false)
        await loadOrders()
      } else {
        toast.error(response.message || t('确认状态失败'))
      }
    } catch {
      toast.error(t('确认状态失败'))
    } finally {
      setBatchSubmitting(false)
    }
  }, [selected, loadOrders, t])

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
        <SectionPageLayout.Title>{t('待确认充值')}</SectionPageLayout.Title>
        <SectionPageLayout.Content>
          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as ManualOrderTab)}
          >
            <TabsList className='mb-4 max-w-full flex-wrap justify-start group-data-horizontal/tabs:h-auto'>
              <TabsTrigger value='pending'>{t('待确认')}</TabsTrigger>
              <TabsTrigger value='history'>{t('充值列表')}</TabsTrigger>
              <TabsTrigger value='analysis'>{t('统计分析')}</TabsTrigger>
            </TabsList>

            <TabsContent value='pending'>
              <div className='mb-3 flex flex-wrap items-center justify-end gap-2'>
                {orders.length > 0 ? (
                  <label className='flex cursor-pointer items-center gap-2 text-sm'>
                    <Checkbox
                      checked={allSelected}
                      indeterminate={selected.size > 0 && !allSelected}
                      onCheckedChange={toggleSelectAll}
                      aria-label={t('全选')}
                    />
                    {t('全选')}
                  </label>
                ) : null}
                <Button
                  variant='outline'
                  onClick={() => setBatchOpen(true)}
                  disabled={selected.size === 0}
                >
                  {t('确认状态')}
                  {selected.size > 0 ? ` (${selected.size})` : ''}
                </Button>
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
              ) : null}
              {!loading && orders.length === 0 ? (
                <div className='text-muted-foreground flex min-h-40 flex-col items-center justify-center py-10 text-center'>
                  <p className='text-sm font-medium'>{t('暂无待确认充值')}</p>
                  <p className='mt-1 text-xs'>
                    {t('用户提交人工充值后会显示在这里')}
                  </p>
                </div>
              ) : null}
              {orders.length > 0 ? (
                <ScrollArea className='max-h-[calc(100dvh-14rem)] pr-3 sm:pr-4'>
                  <div className='space-y-3'>
                    {orders.map((order) => {
                      const highlighted = highlightTradeNo === order.trade_no
                      const checked = selected.has(order.trade_no)
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
                            <div className='flex min-w-0 flex-1 items-start gap-2'>
                              <Checkbox
                                className='mt-0.5'
                                checked={checked}
                                onCheckedChange={() =>
                                  toggleSelect(order.trade_no)
                                }
                                aria-label={t('选择订单')}
                              />
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
                                {t('申请额度')}
                              </Label>
                              <div className='text-sm font-semibold'>
                                {order.amount}
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
                              onClick={() => openConfirm(order)}
                              disabled={submitting}
                            >
                              {t('确认充值')}
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </ScrollArea>
              ) : null}
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
                        <TableHead>{t('订单号')}</TableHead>
                        <TableHead>{t('创建时间')}</TableHead>
                        <TableHead>{t('完成时间')}</TableHead>
                        <TableHead className='text-right'>
                          {t('额度')}
                        </TableHead>
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
                            {t('暂无充值记录')}
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
                            <TableCell className='font-mono text-xs'>
                              {order.trade_no}
                            </TableCell>
                            <TableCell>
                              {formatManualTime(order.create_time)}
                            </TableCell>
                            <TableCell>
                              {formatManualTime(order.complete_time)}
                            </TableCell>
                            <TableCell className='text-right'>
                              {order.amount}
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
        onAmountChange={handleAmountChange}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={handleConfirm}
      />

      <BatchConfirmDialog
        open={batchOpen}
        count={selected.size}
        submitting={batchSubmitting}
        onCancel={() => setBatchOpen(false)}
        onConfirm={handleBatchConfirm}
      />
    </>
  )
}
