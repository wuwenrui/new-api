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

export interface FinanceReportTotalRow {
  requests?: unknown
  consumption_amount?: unknown
  revenue?: unknown
  estimated_upstream_cost?: unknown
  gross_profit?: unknown
  gross_margin?: unknown
  balance?: unknown
  total_topup?: unknown
}

export interface FinanceReportTotals {
  requests: number
  usage_amount: number
  estimated_upstream_cost: number
  gross_profit: number
  gross_margin: number
  balance: number
  total_topup: number
}

function finiteAmount(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

export function sumFinanceReportRows(
  rows: readonly FinanceReportTotalRow[]
): FinanceReportTotals {
  const totals: FinanceReportTotals = {
    requests: 0,
    usage_amount: 0,
    estimated_upstream_cost: 0,
    gross_profit: 0,
    gross_margin: 0,
    balance: 0,
    total_topup: 0,
  }

  for (const row of rows) {
    totals.requests += finiteAmount(row.requests)
    totals.usage_amount += finiteAmount(row.revenue ?? row.consumption_amount)
    totals.estimated_upstream_cost += finiteAmount(row.estimated_upstream_cost)
    totals.gross_profit += finiteAmount(row.gross_profit)
    totals.balance += finiteAmount(row.balance)
    totals.total_topup += finiteAmount(row.total_topup)
  }

  totals.gross_margin =
    totals.usage_amount > 0
      ? (totals.gross_profit / totals.usage_amount) * 100
      : 0
  return totals
}

export function formatPACMonitorStatus(value: unknown): string {
  switch (value) {
    case 'healthy':
      return '正常'
    case 'risk':
      return '低毛利'
    case 'changed':
      return '价格变更'
    case 'unknown':
      return '未知'
    default:
      return '未知'
  }
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
