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
// ----------------------------------------------------------------------------
// Pricing workbench logic: staged edits, margin math, target-margin
// suggestions, auto-tune selection and request building for
// PUT /api/option/pricing. Pure functions; UI lives in components/.
// ----------------------------------------------------------------------------

import { RATIO_TO_USD_PER_MILLION } from '../../channels/lib/newapi-onboard-pricing'
import type { PriceCompareChannel, PriceCompareModel } from '../types'
import { grossMarginPercent, resolveSyncBasis } from './price-sync'

// A purchase price staged on a row, later written to the channel's
// settings.model_prices through the pricing endpoint.
export type StagedCost = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  via: 'detected' | 'manual'
}

// Raw string fields keep number inputs editable while typing; parse on use.
export type RowEdit = {
  saleInput?: string
  saleOutput?: string
  targetMargin?: string
  cost?: StagedCost
}

// The minimal row descriptor the workbench logic operates on.
export type WorkbenchRow = {
  key: string
  modelName: string
  channelId: number
  channelName: string
  billingMode: string
  usesFixedPrice: boolean
  status: PriceCompareChannel['status']
  localInput: number
  localOutput: number
  costInput: number | null
  costOutput: number | null
  detected: StagedCost | null
  margin: number | null
  risk: boolean
  todayProfit: number
}

export function workbenchRowKey(modelName: string, channelId: number): string {
  return `${modelName}|${channelId}`
}

export function workbenchRowFromChannel(
  model: PriceCompareModel,
  channel: PriceCompareChannel
): WorkbenchRow {
  const basis = resolveSyncBasis(channel)
  const margin =
    channel.price_source === 'missing' || basis === null
      ? null
      : Math.min(channel.margin_input, channel.margin_output)
  return {
    key: workbenchRowKey(model.model_name, channel.channel_id),
    modelName: model.model_name,
    channelId: channel.channel_id,
    channelName: channel.channel_name,
    billingMode: channel.billing_mode,
    usesFixedPrice: channel.uses_fixed_price,
    status: channel.status,
    localInput: channel.local_input,
    localOutput: channel.local_output,
    costInput: basis?.input ?? null,
    costOutput: basis?.output ?? null,
    detected:
      channel.detected_available && channel.detected_input > 0
        ? {
            input: channel.detected_input,
            output: channel.detected_output,
            cacheRead: channel.detected_cache_read,
            cacheWrite: channel.detected_cache_write,
            via: 'detected',
          }
        : null,
    margin,
    risk:
      channel.recommendations.length > 0 || (margin !== null && margin < 15),
    todayProfit: channel.today.cost_available ? channel.today.profit : 0,
  }
}

export function flattenWorkbenchRows(
  models: PriceCompareModel[]
): WorkbenchRow[] {
  return models.flatMap((model) =>
    model.channels.map((channel) => workbenchRowFromChannel(model, channel))
  )
}

// Stage every detected upstream price for rows whose cost is unknown.
// Rows without a usable detected price keep their missing state and are
// reported so the admin knows they still need manual entry.
export type FillDetectedResult = {
  changes: Record<string, RowEdit>
  filled: number
  manualOnly: number
}

export function fillDetectedCosts(
  rows: WorkbenchRow[],
  edits: Record<string, RowEdit>
): FillDetectedResult {
  const changes: Record<string, RowEdit> = {}
  let filled = 0
  let manualOnly = 0
  for (const row of rows) {
    if (effectiveCost(row, edits[row.key]) !== null) continue
    if (row.detected) {
      changes[row.key] = { ...edits[row.key], cost: row.detected }
      filled++
    } else {
      manualOnly++
    }
  }
  return { changes, filled, manualOnly }
}

export function parseEditNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

export function effectiveSale(
  row: WorkbenchRow,
  edit: RowEdit | undefined
): { input: number; output: number } {
  return {
    input: parseEditNumber(edit?.saleInput) ?? row.localInput,
    output: parseEditNumber(edit?.saleOutput) ?? row.localOutput,
  }
}

export function effectiveCost(
  row: WorkbenchRow,
  edit: RowEdit | undefined
): { input: number; output: number } | null {
  if (edit?.cost) return { input: edit.cost.input, output: edit.cost.output }
  if (row.costInput === null || row.costOutput === null) return null
  return { input: row.costInput, output: row.costOutput }
}

// Current gross margin (on the sale price), the lower of input/output.
export function workbenchMargin(
  row: WorkbenchRow,
  edit: RowEdit | undefined
): number | null {
  const cost = effectiveCost(row, edit)
  if (!cost) return null
  const sale = effectiveSale(row, edit)
  const input = grossMarginPercent(sale.input, cost.input)
  const output = grossMarginPercent(sale.output, cost.output)
  if (input === null && output === null) return null
  return Math.min(
    input ?? Number.POSITIVE_INFINITY,
    output ?? Number.POSITIVE_INFINITY
  )
}

export function isPriceDirty(
  row: WorkbenchRow,
  edit: RowEdit | undefined
): boolean {
  if (!edit) return false
  const si = parseEditNumber(edit.saleInput)
  const so = parseEditNumber(edit.saleOutput)
  return (
    (si !== null && si !== row.localInput) ||
    (so !== null && so !== row.localOutput)
  )
}

export function isRowDirty(
  row: WorkbenchRow,
  edit: RowEdit | undefined
): boolean {
  return isPriceDirty(row, edit) || edit?.cost !== undefined
}

// Rows that cannot be written through the ratio pricing endpoint. Note the
// compare status only reports whether the upstream cost is known — it never
// blocks writes (staging a purchase price is exactly how it gets fixed).
export function unwriteableReason(
  row: WorkbenchRow
): 'fixed' | 'tiered' | null {
  if (row.usesFixedPrice) return 'fixed'
  if (row.billingMode === 'tiered_expr') return 'tiered'
  return null
}

export function ceilToStep(value: number, step: number): number {
  if (step <= 0) return value
  return Math.ceil(value / step - 1e-9) * step
}

export function roundEditable(value: number): string {
  return String(Number(value.toFixed(4)))
}

// Suggest sale prices from the effective cost and a target gross margin
// (percent on the sale price). Both cost legs must be positive; a locked
// completion ratio pins output to input × ratio.
export function suggestSalePrices(
  cost: { input: number; output: number },
  targetMarginPct: number,
  step: number,
  lockedCompletionRatio?: number
): { saleInput: number; saleOutput: number } | null {
  if (
    !Number.isFinite(targetMarginPct) ||
    targetMarginPct < 0 ||
    targetMarginPct >= 100
  ) {
    return null
  }
  if (!Number.isFinite(cost.input) || cost.input <= 0) return null
  if (!Number.isFinite(cost.output) || cost.output <= 0) return null
  const factor = 1 - targetMarginPct / 100
  const saleInput = ceilToStep(cost.input / factor, step)
  const saleOutput =
    lockedCompletionRatio !== undefined && lockedCompletionRatio > 0
      ? ceilToStep(saleInput * lockedCompletionRatio, step)
      : ceilToStep(cost.output / factor, step)
  return { saleInput, saleOutput }
}

export type AutotuneScope = 'below' | 'all' | 'risk'

export type AutotuneResult = {
  changes: Record<string, RowEdit>
  tuned: number
  already: number
  skipped: number
}

export function autotuneRows(
  rows: WorkbenchRow[],
  edits: Record<string, RowEdit>,
  scope: AutotuneScope,
  targetMarginPct: number,
  step: number
): AutotuneResult {
  const changes: Record<string, RowEdit> = {}
  let tuned = 0
  let already = 0
  let skipped = 0
  for (const row of rows) {
    const edit = edits[row.key]
    const cost = effectiveCost(row, edit)
    if (!cost || unwriteableReason(row) !== null) {
      skipped++
      continue
    }
    if (scope === 'risk' && !row.risk) continue
    const margin = workbenchMargin(row, edit)
    if (scope === 'below' && margin !== null && margin >= targetMarginPct) {
      already++
      continue
    }
    const suggestion = suggestSalePrices(cost, targetMarginPct, step)
    if (!suggestion) {
      skipped++
      continue
    }
    changes[row.key] = {
      ...edit,
      saleInput: roundEditable(suggestion.saleInput),
      saleOutput: roundEditable(suggestion.saleOutput),
      targetMargin: String(targetMarginPct),
    }
    tuned++
  }
  return { changes, tuned, already, skipped }
}

// ---------------------------------------------------------------------------
// Request building for PUT /api/option/pricing
// ---------------------------------------------------------------------------

export type RatioOptionSnapshot = {
  groupRatio: number
  modelRatio: number | undefined
  completionRatio: number | undefined
  cacheRatio: number | undefined
  createCacheRatio: number | undefined
  lockedCompletionRatio: number | undefined
  hasFixedPrice: boolean
}

export type BuildRequestFailure = {
  ok: false
  reason:
    | 'fixed-price'
    | 'missing-current-ratio'
    | 'drift'
    | 'locked-completion-conflict'
    | 'invalid-sale-price'
  detail?: string
}

export type RatioSyncRequestBody = {
  model_name: string
  billing_mode: 'ratio'
  model_ratio: number
  completion_ratio?: number
  cache_ratio: number
  create_cache_ratio: number
}

// Merge a staged purchase price into a channel's settings JSON (the
// settings.model_prices map maintained by the channel edit drawer). Existing
// keys and settings survive; the model entry is replaced wholesale.
export function mergeModelPriceIntoSettings(
  settingsJson: string,
  modelName: string,
  cost: StagedCost
): string {
  let settings: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(settingsJson || '{}')
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      settings = parsed as Record<string, unknown>
    }
  } catch {
    settings = {}
  }
  const prices =
    typeof settings.model_prices === 'object' &&
    settings.model_prices !== null &&
    !Array.isArray(settings.model_prices)
      ? { ...(settings.model_prices as Record<string, unknown>) }
      : {}
  prices[modelName] = {
    input: cost.input,
    output: cost.output,
    cache_read: cost.cacheRead,
    cache_write: cost.cacheWrite,
    source: 'manual',
  }
  return JSON.stringify({ ...settings, model_prices: prices })
}

export type BuildRequestSuccess = { ok: true; request: RatioSyncRequestBody }
export type BuildRequestResult = BuildRequestSuccess | BuildRequestFailure

const DRIFT_TOLERANCE = 0.01

export function buildRatioSyncRequest(
  row: WorkbenchRow,
  edit: RowEdit,
  snapshot: RatioOptionSnapshot
): BuildRequestResult {
  if (snapshot.hasFixedPrice) return { ok: false, reason: 'fixed-price' }
  if (snapshot.modelRatio === undefined || snapshot.groupRatio <= 0) {
    return { ok: false, reason: 'missing-current-ratio' }
  }
  // Drift check: the online selling price must still match what the plan was
  // staged from, otherwise the write would silently rebase the model.
  const onlineUsd =
    snapshot.modelRatio * snapshot.groupRatio * RATIO_TO_USD_PER_MILLION
  if (
    row.localInput > 0 &&
    Math.abs(onlineUsd - row.localInput) / row.localInput > DRIFT_TOLERANCE
  ) {
    return {
      ok: false,
      reason: 'drift',
      detail: `${onlineUsd}`,
    }
  }

  const priceDirty = isPriceDirty(row, edit)
  const sale = effectiveSale(row, edit)
  let modelRatio = snapshot.modelRatio
  let completionRatio = snapshot.completionRatio
  if (priceDirty) {
    if (!(sale.input > 0) || !(sale.output >= 0)) {
      return { ok: false, reason: 'invalid-sale-price' }
    }
    modelRatio = sale.input / snapshot.groupRatio / RATIO_TO_USD_PER_MILLION
    completionRatio = sale.output / sale.input
  }
  const locked = snapshot.lockedCompletionRatio
  if (locked !== undefined && completionRatio !== undefined) {
    if (Math.abs(completionRatio - locked) / locked > 0.005) {
      return {
        ok: false,
        reason: 'locked-completion-conflict',
        detail: `${locked}`,
      }
    }
    completionRatio = locked
  }
  if (!Number.isFinite(modelRatio) || modelRatio < 0) {
    return { ok: false, reason: 'invalid-sale-price' }
  }

  return {
    ok: true,
    request: {
      model_name: row.modelName,
      billing_mode: 'ratio',
      model_ratio: modelRatio,
      completion_ratio: completionRatio,
      cache_ratio: snapshot.cacheRatio ?? 1,
      create_cache_ratio: snapshot.createCacheRatio ?? 1,
    },
  }
}
