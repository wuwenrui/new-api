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
import { Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatCurrency } from '../../lib'
import type { ManualTopUpOrder } from '../../types'

interface ManualTopUpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  order: ManualTopUpOrder | null
  onOpenBilling?: () => void
}

export function ManualTopUpDialog({
  open,
  onOpenChange,
  order,
  onOpenBilling,
}: ManualTopUpDialogProps) {
  const { t } = useTranslation()
  const { copyToClipboard } = useCopyToClipboard()

  if (!order) {
    return null
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-sm:w-[calc(100vw-1.5rem)] sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>{t('Manual QR top-up')}</DialogTitle>
          <DialogDescription>
            {t('Scan the QR code and wait for administrator confirmation.')}
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-4'>
          <div className='grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-sm'>
            <span className='text-muted-foreground'>{t('Payment Method')}</span>
            <span className='font-medium'>{order.payment_name}</span>

            <span className='text-muted-foreground'>{t('You Pay')}</span>
            <span className='text-lg font-semibold'>
              ¥{formatCurrency(order.money)}
            </span>

            <span className='text-muted-foreground'>{t('Order No')}</span>
            <span className='flex min-w-0 items-center gap-2'>
              <code className='bg-muted min-w-0 truncate rounded px-2 py-1 text-xs'>
                {order.trade_no}
              </code>
              <Button
                type='button'
                variant='ghost'
                size='icon-sm'
                onClick={() => copyToClipboard(order.trade_no)}
              >
                <Copy className='h-4 w-4' />
                <span className='sr-only'>{t('Copy order number')}</span>
              </Button>
            </span>
          </div>

          <div className='bg-muted/40 flex justify-center rounded-lg border p-3'>
            <img
              src={order.qr_url}
              alt={order.payment_name}
              className='aspect-square w-full max-w-60 rounded-md bg-white object-contain p-2'
              referrerPolicy='no-referrer'
            />
          </div>

          <p className='text-muted-foreground text-sm'>
            {order.instructions ||
              t('Please include the order number in payment remarks.')}
          </p>
        </div>

        <DialogFooter className='grid grid-cols-2 gap-2 sm:flex'>
          {onOpenBilling && (
            <Button
              type='button'
              variant='outline'
              onClick={() => {
                onOpenChange(false)
                onOpenBilling()
              }}
            >
              {t('Billing History')}
            </Button>
          )}
          <Button type='button' onClick={() => onOpenChange(false)}>
            {t('I have paid')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
