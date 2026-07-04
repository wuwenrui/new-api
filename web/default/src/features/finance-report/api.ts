import { api } from '@/lib/api'

import { buildFinanceReportQuery } from './lib'

interface FinanceReportSummary {
  requests: number
  consumption_amount: number
  estimated_upstream_cost: number
  gross_profit: number
  gross_margin: number
  cash_income_amount: number
  cash_topup_amount: number
  cash_subscription_amount: number
  user_balance_amount: number
}

export interface FinanceModelRow {
  model_name: string
  requests: number
  consumption_amount: number
  estimated_upstream_cost: number
  gross_profit: number
  gross_margin: number
}

export interface FinanceUserRow {
  username: string
  requests: number
  consumption_amount: number
  gross_profit: number
  gross_margin: number
  balance: number
  total_topup: number
}

export interface FinanceReportData {
  summary: FinanceReportSummary
  models: FinanceModelRow[]
  users: FinanceUserRow[]
}

interface FinanceReportResponse {
  success: boolean
  message: string
  data: FinanceReportData
}

export async function getFinanceReport(params: {
  start_timestamp: number
  end_timestamp: number
  username?: string
}): Promise<FinanceReportData | null> {
  const query = buildFinanceReportQuery(params)
  const res = await api.get<FinanceReportResponse>(
    `/api/finance/report${query ? `?${query}` : ''}`
  )
  const { success, data } = res.data
  if (!success) return null
  return data
}

export interface FinanceOrderRow {
  id: number
  user_id: number
  username: string
  email: string
  money: number
  amount: number
  plan_id: number
  trade_no: string
  payment_method: string
  status: string
  create_time: number
  complete_time: number
}

export interface FinanceOrderPage {
  page: number
  page_size: number
  total: number
  items: FinanceOrderRow[] | null
}

export interface FinanceBalanceRow {
  username: string
  balance: number
  total_topup: number
  total_consumed: number
  gifted_estimate: number
}

interface ApiEnvelope<T> {
  success: boolean
  message: string
  data: T
}

export interface FinanceOrderQuery {
  start_timestamp: number
  end_timestamp: number
  status?: string
  username?: string
  p?: number
  size?: number
}

async function getFinanceOrderPage(
  path: string,
  params: FinanceOrderQuery
): Promise<FinanceOrderPage | null> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === 0) {
      continue
    }
    search.set(key, String(value))
  }
  const query = search.toString()
  const res = await api.get<ApiEnvelope<FinanceOrderPage>>(
    `${path}${query ? `?${query}` : ''}`
  )
  if (!res.data.success) return null
  return res.data.data
}

export function getFinanceTopUps(params: FinanceOrderQuery) {
  return getFinanceOrderPage('/api/finance/topups', params)
}

export function getFinanceSubscriptionOrders(params: FinanceOrderQuery) {
  return getFinanceOrderPage('/api/finance/subscription-orders', params)
}

export async function getFinanceBalances(): Promise<
  FinanceBalanceRow[] | null
> {
  const res = await api.get<ApiEnvelope<FinanceBalanceRow[]>>(
    '/api/finance/balances'
  )
  if (!res.data.success) return null
  return res.data.data
}
