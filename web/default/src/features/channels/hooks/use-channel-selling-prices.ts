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
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useFormContext, useWatch } from 'react-hook-form'

import type { ChannelFormValues } from '../lib/channel-form'
import {
  buildSaleRequest,
  draftPrices,
  parsePriceRecord,
  parsePurchase,
  type SaleDraft,
  type SaleSnapshot,
  type TokenPrices,
} from '../lib/channel-sale-pricing'
import { loadChannelSale, saveChannelSale } from '../lib/channel-sale-save'

export function useChannelSellingPrices() {
  const form = useFormContext<ChannelFormValues>()
  const [modelsRaw, groupsRaw, purchaseRaw] = useWatch({
    control: form.control,
    name: ['models', 'group', 'model_prices'],
  })
  const models = [
    ...new Set(
      String(modelsRaw || '')
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean)
    ),
  ].sort()
  const groups = Array.isArray(groupsRaw) ? groupsRaw : []
  const [selectedGroup, setGroup] = useState('')
  const group = groups.includes(selectedGroup)
    ? selectedGroup
    : groups[0] || 'default'
  const [drafts, setDrafts] = useState<Record<string, SaleDraft>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const client = useQueryClient()
  const queries = useQueries({
    queries: models.map((model) => ({
      queryKey: ['channel-selling-price', model],
      queryFn: () => loadChannelSale(model),
      staleTime: 60_000,
      retry: false,
    })),
  })
  let purchases: Record<string, unknown> = {}
  try {
    purchases = parsePriceRecord(String(purchaseRaw || '{}'))
  } catch {
    /* Purchase form reports malformed input; keep costs unavailable. */
  }
  const rows = models.map((model, index) => {
    const id = JSON.stringify([model, group])
    const query = queries[index]
    const snapshot = query.data
    const draft = drafts[id]
    const cost = parsePurchase(purchases[model])
    const proposed = draft ? draftPrices(draft, cost) : null
    let validation = ''
    if (draft && !proposed) {
      validation =
        'Enter all four prices or a valid target margin from 0 to below 100%.'
    }
    if (draft && proposed && snapshot) {
      try {
        buildSaleRequest(snapshot, proposed, snapshot.groups[group])
      } catch (error) {
        validation =
          error instanceof Error ? error.message : 'Invalid selling price.'
      }
    }
    return {
      id,
      model,
      snapshot,
      draft,
      cost,
      proposed,
      validation,
      error: errors[model] || query.error?.message,
      loading: query.isPending || query.isFetching,
      readFailed: query.isError,
    }
  })
  const setDraft = (
    snapshot: SaleSnapshot,
    patch: Pick<SaleDraft, 'margin' | 'manual'>
  ) => {
    const id = JSON.stringify([snapshot.model, group])
    setDrafts((previous) => ({
      ...previous,
      [id]: { ...patch, group, base: snapshot },
    }))
    setErrors((previous) => ({ ...previous, [snapshot.model]: '' }))
  }
  const clearDraft = (id: string) =>
    setDrafts((previous) => {
      const next = { ...previous }
      delete next[id]
      return next
    })
  const mutation = useMutation({
    retry: false,
    mutationFn: async (
      entries: Array<{ draft: SaleDraft; prices: TokenPrices }>
    ) => {
      const results: Array<{
        model: string
        snapshot?: SaleSnapshot
        error?: string
      }> = []
      for (const entry of entries) {
        try {
          results.push({
            model: entry.draft.base.model,
            snapshot: await saveChannelSale(entry.draft, entry.prices),
          })
        } catch (error) {
          results.push({
            model: entry.draft.base.model,
            error:
              error instanceof Error
                ? error.message
                : 'Could not save selling prices.',
          })
        }
      }
      return results
    },
    onSuccess: (results) => {
      for (const result of results) {
        if (result.snapshot) {
          client.setQueryData(
            ['channel-selling-price', result.model],
            result.snapshot
          )
          void client.invalidateQueries({
            queryKey: ['channel-selling-price'],
            predicate: (query) =>
              query.queryKey[1] !== result.model &&
              (query.state.data as SaleSnapshot | undefined)?.key ===
                result.snapshot?.key,
          })
          setDrafts((previous) =>
            Object.fromEntries(
              Object.entries(previous).filter(
                ([, draft]) => draft.base.model !== result.model
              )
            )
          )
        }
        setErrors((previous) => ({
          ...previous,
          [result.model]: result.error || '',
        }))
      }
      if (results.some((result) => result.snapshot)) {
        for (const key of [
          'pricing',
          'system-options',
          'channel-price-compare',
        ]) {
          void client.invalidateQueries({ queryKey: [key] })
        }
      }
    },
  })
  const pending = rows.filter((row) => row.draft)
  const canSave =
    pending.length > 0 &&
    !mutation.isPending &&
    pending.every(
      (row) =>
        row.proposed && !row.validation && !row.loading && !row.readFailed
    )
  const save = () =>
    mutation.mutate(
      pending.flatMap((row) =>
        row.draft && row.proposed
          ? [{ draft: row.draft, prices: row.proposed }]
          : []
      )
    )
  return {
    rows,
    group,
    groups,
    setGroup,
    setDraft,
    clearDraft,
    canSave,
    save,
    pending: pending.length,
    saving: mutation.isPending,
    results: mutation.data,
    refresh: () =>
      client.invalidateQueries({ queryKey: ['channel-selling-price'] }),
  }
}
