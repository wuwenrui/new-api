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
}): Promise<FinanceReportData | null> {
  const query = buildFinanceReportQuery(params)
  const res = await api.get<FinanceReportResponse>(
    `/api/finance/report${query ? `?${query}` : ''}`
  )
  const { success, data } = res.data
  if (!success) return null
  return data
}
