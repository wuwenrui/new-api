import type { TFunction } from 'i18next'
import { formatNumber, formatTimestampToDate } from '@/lib/format'
import type { StatusVariant } from '@/components/status-badge'

export function toTimestamp(value: string): number {
  if (!value) return 0
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return 0
  return Math.floor(timestamp / 1000)
}

export function formatManualMoney(value: number | undefined): string {
  return `¥${formatNumber(value ?? 0)}`
}

export function formatManualTime(value: number | undefined): string {
  return value && value > 0 ? formatTimestampToDate(value) : '-'
}

export function statusVariant(status: string): StatusVariant {
  switch (status) {
    case 'success':
      return 'success'
    case 'failed':
      return 'danger'
    case 'expired':
      return 'neutral'
    case 'pending':
    default:
      return 'warning'
  }
}

export function statusLabel(status: string, t: TFunction): string {
  switch (status) {
    case 'success':
      return t('已确认')
    case 'failed':
      return t('失败')
    case 'expired':
      return t('已过期')
    case 'pending':
      return t('待确认')
    default:
      return status || t('未知')
  }
}
