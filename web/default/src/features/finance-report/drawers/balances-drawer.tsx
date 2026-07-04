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

import { getFinanceBalances, type FinanceBalanceRow } from '../api'
import { formatFinanceAmount, formatGiftedEstimate } from '../lib'

export function BalancesDrawer({
  open,
  onOpenChange,
  onSelectUser,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectUser?: (username: string) => void
}) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<FinanceBalanceRow[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const result = await getFinanceBalances()
        if (!cancelled) setRows(result ?? [])
      } catch {
        if (!cancelled) setRows([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [open])

  const totalBalance = rows.reduce((sum, row) => sum + (row.balance || 0), 0)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className={sideDrawerContentClassName('sm:max-w-3xl')}>
        <SheetHeader className={sideDrawerHeaderClassName()}>
          <SheetTitle className='flex items-center gap-2'>
            {t('用户余额明细')}
            <Badge variant='secondary'>
              {t('合计')} {formatFinanceAmount(totalBalance, '¥')}
            </Badge>
          </SheetTitle>
        </SheetHeader>
        <div className={sideDrawerFormClassName()}>
          {loading ? (
            <div className='flex items-center justify-center py-12'>
              <Spinner className='size-6' />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('用户')}</TableHead>
                  <TableHead className='text-right'>{t('当前余额')}</TableHead>
                  <TableHead className='text-right'>{t('累计充值')}</TableHead>
                  <TableHead className='text-right'>{t('累计消费')}</TableHead>
                  <TableHead className='text-right'>{t('赠送估算')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={row.username}
                    className={onSelectUser ? 'cursor-pointer' : undefined}
                    onClick={() => onSelectUser?.(row.username)}
                  >
                    <TableCell className='font-medium'>
                      {row.username}
                    </TableCell>
                    <TableCell className='text-right'>
                      {formatFinanceAmount(row.balance, '¥')}
                    </TableCell>
                    <TableCell className='text-right'>
                      {formatFinanceAmount(row.total_topup, '¥')}
                    </TableCell>
                    <TableCell className='text-right'>
                      {formatFinanceAmount(row.total_consumed, '¥')}
                    </TableCell>
                    <TableCell className='text-right'>
                      {formatGiftedEstimate(row.gifted_estimate, '¥')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
