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
import { useCallback, useState } from 'react'
import i18next from 'i18next'
import { toast } from 'sonner'
import { isApiSuccess, requestManualTopUpPayment } from '../api'
import type { ManualTopUpOrder } from '../types'

export function useManualTopUpPayment() {
  const [processing, setProcessing] = useState(false)
  const [order, setOrder] = useState<ManualTopUpOrder | null>(null)

  const processManualTopUpPayment = useCallback(
    async (topupAmount: number, paymentType: string) => {
      try {
        setProcessing(true)
        const response = await requestManualTopUpPayment({
          amount: Math.floor(topupAmount),
          payment_method: paymentType,
        })

        if (!isApiSuccess(response) || !response.data) {
          toast.error(response.message || i18next.t('Payment request failed'))
          return null
        }

        setOrder(response.data)
        toast.success(i18next.t('Manual top-up order created'))
        return response.data
      } catch (_error) {
        toast.error(i18next.t('Payment request failed'))
        return null
      } finally {
        setProcessing(false)
      }
    },
    []
  )

  return {
    order,
    processing,
    setOrder,
    processManualTopUpPayment,
  }
}
