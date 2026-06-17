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
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { formatNumber, formatTimestampToDate } from '@/lib/format'
import { SectionPageLayout } from '@/components/layout'
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
import { StatusBadge } from '@/components/status-badge'
import {
  completeOrderWithAmount,
  confirmManualTopUpStatus,
  getPendingManualTopUps,
  isApiSuccess,
} from './api'
import { findOrderIndexByTradeNo, previewQuota } from './lib'
import type { PendingManualTopUp } from './types'

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
              <Label htmlFor='recharge-review-amount'>
                {t('充值额度')}
              </Label>
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
  const [orders, setOrders] = useState<PendingManualTopUp[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null)
  const [highlightTradeNo, setHighlightTradeNo] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchSubmitting, setBatchSubmitting] = useState(false)
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

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void loadOrders()
    })
    return () => {
      cancelled = true
    }
  }, [loadOrders])

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
        toast.success(`${t('确认状态成功')}: ${response.data?.count ?? tradeNos.length}`)
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

  return (
    <>
      <SectionPageLayout>
        <SectionPageLayout.Title>{t('待确认充值')}</SectionPageLayout.Title>
        <SectionPageLayout.Actions>
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
          <Button variant='outline' onClick={loadOrders} disabled={loading}>
            {loading ? <Spinner /> : <RefreshCw size={14} />}
            {t('Refresh')}
          </Button>
        </SectionPageLayout.Actions>
        <SectionPageLayout.Content>
          {loading && orders.length === 0 ? (
            <div className='flex items-center justify-center py-16'>
              <Spinner className='size-6' />
            </div>
          ) : orders.length === 0 ? (
            <div className='text-muted-foreground flex min-h-40 flex-col items-center justify-center py-10 text-center'>
              <p className='text-sm font-medium'>{t('暂无待确认充值')}</p>
              <p className='mt-1 text-xs'>{t('用户提交人工充值后会显示在这里')}</p>
            </div>
          ) : (
            <ScrollArea className='max-h-[calc(100dvh-12rem)] pr-3 sm:pr-4'>
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
                            onCheckedChange={() => toggleSelect(order.trade_no)}
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
          )}
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
