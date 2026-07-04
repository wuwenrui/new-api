export interface CurrencyConfig {
  symbol: string
  rate: number
  type: string
}

function storageGet(key: string): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(key)
}

function safeStatus(): Record<string, unknown> {
  try {
    return JSON.parse(storageGet('status') || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

function finiteRate(value: unknown, fallback: number): number {
  const rate = Number(value)
  return Number.isFinite(rate) && rate > 0 ? rate : fallback
}

export function formatFinanceAmount(
  value: unknown,
  currency: CurrencyConfig | string = '$'
): string {
  const numeric = Number(value)
  const amount = Number.isFinite(numeric) ? numeric : 0
  const config =
    typeof currency === 'string'
      ? { symbol: currency, rate: 1 }
      : {
          symbol: currency?.symbol || '$',
          rate: finiteRate(currency?.rate, 1),
        }
  return `${config.symbol}${(amount * config.rate).toFixed(2)}`
}

// 赠送估算 = 余额 + 累计消费 - 累计充值；负值代表用户花超了赠送部分，展示时截 0
export function formatGiftedEstimate(
  value: unknown,
  currency: CurrencyConfig | string = '$'
): string {
  const numeric = Number(value)
  const clamped = Number.isFinite(numeric) && numeric > 0 ? numeric : 0
  return formatFinanceAmount(clamped, currency)
}

export function getFinanceCurrencyConfig(): CurrencyConfig {
  const type = storageGet('quota_display_type') || 'USD'
  const status = safeStatus()

  if (type === 'CNY') {
    return {
      symbol: '¥',
      rate: finiteRate(status?.usd_exchange_rate, 1),
      type,
    }
  }
  if (type === 'CUSTOM') {
    return {
      symbol: (status?.custom_currency_symbol as string) || '¤',
      rate: finiteRate(status?.custom_currency_exchange_rate, 1),
      type,
    }
  }
  return { symbol: '$', rate: 1, type }
}

export function formatFinancePercent(value: unknown): string {
  const numeric = Number(value)
  const percent = Number.isFinite(numeric) ? numeric : 0
  return `${percent.toFixed(2)}%`
}

export function buildFinanceReportQuery(
  params: Record<string, unknown> = {}
): string {
  const orderedKeys = [
    'start_timestamp',
    'end_timestamp',
    'model_name',
    'username',
    'group',
    'channel',
  ]
  const search = new URLSearchParams()
  for (const key of orderedKeys) {
    const value = params[key]
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  return search.toString()
}

export function startOfToday(): Date {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

export function toInputValue(date: Date): string {
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function toTimestamp(value: string): number {
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return 0
  return Math.floor(time / 1000)
}
