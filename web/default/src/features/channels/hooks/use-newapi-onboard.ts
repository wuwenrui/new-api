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
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  getSystemOptions,
  updateSystemOption,
} from '@/features/system-settings/api'
import { useStatus } from '@/hooks/use-status'
import { useSystemConfig } from '@/hooks/use-system-config'
import { createChannel, getGroups, probeNewAPIUpstream } from '../api'
import { channelsQueryKeys } from '../lib'
import {
  RATIO_OPTION_KEYS,
  type SaleOverride,
  applyModelPricing,
  extractRatioMaps,
  parseJsonRecord,
  roundRatio,
  upstreamCostInUSD,
} from '../lib/newapi-onboard-pricing'
import type { NewAPIProbeModel, NewAPIProbeResult } from '../types'

export const CHANNEL_TYPE_OPENAI = 1
export const CHANNEL_TYPE_ANTHROPIC = 14

export type WizardStep = 'connect' | 'select' | 'finalize'
export type Currency = 'USD' | 'CNY'

export function useNewAPIOnboard(open: boolean, onOpenChange: (v: boolean) => void) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const systemConfig = useSystemConfig()
  const { status } = useStatus()

  const [step, setStep] = useState<WizardStep>('connect')
  const [maximized, setMaximized] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [userId, setUserId] = useState('')
  const [isProbing, setIsProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<NewAPIProbeResult | null>(
    null
  )

  const [billingGroup, setBillingGroup] = useState('')
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set())
  const [searchKeyword, setSearchKeyword] = useState('')
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())
  const [markupInput, setMarkupInput] = useState('1')
  const [saleOverrides, setSaleOverrides] = useState<
    Record<string, SaleOverride>
  >({})
  const [currency, setCurrency] = useState<Currency>(() =>
    systemConfig.currency.quotaDisplayType === 'CNY' ? 'CNY' : 'USD'
  )

  const [channelName, setChannelName] = useState('')
  const [channelKey, setChannelKey] = useState('')
  const [channelType, setChannelType] = useState(CHANNEL_TYPE_OPENAI)
  const [localGroups, setLocalGroups] = useState<Set<string>>(
    new Set(['default'])
  )
  const [modelAliases, setModelAliases] = useState<Record<string, string>>({})
  const [syncPricing, setSyncPricing] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Real-money CNY conversion uses the RECHARGE price (CNY paid per $1 of
  // quota), not the display-only usd_exchange_rate. Sites like packyapi sell
  // $1 quota for ¥1 (price=1) while displaying an exchange rate of 7.
  const upstreamRechargePrice = probeResult?.rate_info?.price || 1
  const upstreamDisplayRate = probeResult?.rate_info?.usd_exchange_rate || 1
  const ourRechargePrice = Math.max((status?.price as number) || 1, 0.001)

  const groupRatio = useMemo(
    () => probeResult?.group_ratio ?? {},
    [probeResult]
  )
  const usableGroup = useMemo(
    () => probeResult?.usable_group ?? {},
    [probeResult]
  )

  const upstreamGroups = useMemo(() => {
    const names = new Set<string>(Object.keys(groupRatio))
    probeResult?.models.forEach((m) =>
      (m.enable_groups ?? []).forEach((g) => names.add(g))
    )
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [probeResult, groupRatio])

  // vendor_id -> vendor name; models with unknown vendor go to ''
  const vendorNameById = useMemo(() => {
    const map = new Map<number, string>()
    probeResult?.vendors?.forEach((v) => map.set(v.id, v.name))
    return map
  }, [probeResult])

  const vendorSections = useMemo(() => {
    const byVendor = new Map<string, NewAPIProbeModel[]>()
    probeResult?.models.forEach((m) => {
      const name = vendorNameById.get(m.vendor_id) ?? ''
      const list = byVendor.get(name) ?? []
      list.push(m)
      byVendor.set(name, list)
    })
    return [...byVendor.entries()]
      .map(([name, models]) => ({ name, models }))
      .sort((a, b) => b.models.length - a.models.length)
  }, [probeResult, vendorNameById])

  const markup = useMemo(() => {
    const parsed = Number(markupInput)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
  }, [markupInput])

  const selectedModelObjects = useMemo(
    () =>
      (probeResult?.models ?? []).filter((m) =>
        selectedModels.has(m.model_name)
      ),
    [probeResult, selectedModels]
  )

  const { data: optionsResp } = useQuery({
    queryKey: ['system-options'],
    queryFn: getSystemOptions,
    enabled: open && step !== 'connect',
  })
  const currentRatioMaps = useMemo(
    () => extractRatioMaps(optionsResp?.data ?? []),
    [optionsResp]
  )
  const siteGroupRatioMap = useMemo(() => {
    const opt = (optionsResp?.data ?? []).find(
      (o: { key: string; value: string }) => o.key === 'GroupRatio'
    )
    return parseJsonRecord(opt?.value)
  }, [optionsResp])
  const siteGroupRatio = siteGroupRatioMap['default'] ?? 1

  const { data: groupsResp } = useQuery({
    queryKey: ['user-groups'],
    queryFn: getGroups,
    enabled: open && step === 'finalize',
  })
  const availableLocalGroups = groupsResp?.data ?? ['default']

  const baseGroupRatioFor = (m: NewAPIProbeModel): number => {
    const groups = m.enable_groups ?? []
    if (billingGroup && groups.includes(billingGroup)) {
      return groupRatio[billingGroup] ?? 1
    }
    const own = groups[0]
    return (own && groupRatio[own]) || 1
  }

  const saleInUSD = (m: NewAPIProbeModel): number =>
    saleOverrides[m.model_name]?.in ??
    upstreamCostInUSD(m, baseGroupRatioFor(m)) * markup

  const saleOutUSD = (m: NewAPIProbeModel): number | null => {
    if (m.quota_type === 1) return null
    return saleOverrides[m.model_name]?.out ?? saleInUSD(m) * m.completion_ratio
  }

  const localNameFor = (upstreamName: string): string =>
    modelAliases[upstreamName]?.trim() || upstreamName

  const outOfBillingGroup = useMemo(
    () =>
      billingGroup
        ? selectedModelObjects
            .filter((m) => !(m.enable_groups ?? []).includes(billingGroup))
            .map((m) => m.model_name)
        : [],
    [selectedModelObjects, billingGroup]
  )

  const pricingConflicts = useMemo(() => {
    if (!syncPricing) return []
    const divisor = siteGroupRatio > 0 ? siteGroupRatio : 1
    return selectedModelObjects
      .filter((m) => {
        const local = localNameFor(m.model_name)
        if (m.quota_type === 1) {
          const existing = currentRatioMaps.ModelPrice[local]
          return (
            existing !== undefined &&
            existing !== roundRatio(saleInUSD(m) / divisor)
          )
        }
        const existing = currentRatioMaps.ModelRatio[local]
        return (
          existing !== undefined &&
          existing !== roundRatio(saleInUSD(m) / 2 / divisor)
        )
      })
      .map((m) => localNameFor(m.model_name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    syncPricing,
    selectedModelObjects,
    currentRatioMaps,
    saleOverrides,
    markup,
    billingGroup,
    groupRatio,
    siteGroupRatio,
    modelAliases,
  ])

  // Currency helpers: CNY mode converts by recharge prices — cost by the
  // upstream's, sale by ours — so ¥ figures are real money on both sides.
  const symbol = currency === 'CNY' ? '¥' : '$'
  const fmtCost = (usd: number) =>
    `${symbol}${roundRatio(usd * (currency === 'CNY' ? upstreamRechargePrice : 1))}`
  const saleDisplayValue = (usd: number) =>
    roundRatio(usd * (currency === 'CNY' ? ourRechargePrice : 1))
  const saleInputToUSD = (raw: string): number | undefined => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) return undefined
    return currency === 'CNY' ? parsed / ourRechargePrice : parsed
  }

  const resetState = () => {
    setStep('connect')
    setBaseUrl('')
    setAccessToken('')
    setUserId('')
    setProbeResult(null)
    setBillingGroup('')
    setHiddenGroups(new Set())
    setSearchKeyword('')
    setSelectedModels(new Set())
    setMarkupInput('1')
    setSaleOverrides({})
    setChannelName('')
    setChannelKey('')
    setChannelType(CHANNEL_TYPE_OPENAI)
    setLocalGroups(new Set(['default']))
    setModelAliases({})
    setSyncPricing(true)
  }

  const handleClose = () => {
    resetState()
    onOpenChange(false)
  }

  const handleProbe = async () => {
    if (!baseUrl.trim()) {
      toast.error(t('Please enter the upstream site address'))
      return
    }
    setIsProbing(true)
    try {
      const resp = await probeNewAPIUpstream({
        base_url: baseUrl.trim(),
        access_token: accessToken.trim() || undefined,
        user_id: userId.trim() || undefined,
      })
      if (!resp.success || !resp.data) {
        toast.error(resp.message || t('Failed to probe upstream site'))
        return
      }
      setProbeResult(resp.data)
      setSelectedModels(new Set())
      setSaleOverrides({})
      setModelAliases({})
      setHiddenGroups(new Set())
      const groups = Object.keys(resp.data.group_ratio ?? {}).sort((a, b) =>
        a.localeCompare(b)
      )
      setBillingGroup(groups[0] ?? '')
      setStep('select')
      toast.success(
        t('Found {{models}} models and {{groups}} groups', {
          models: resp.data.models.length,
          groups: groups.length,
        })
      )
    } catch (error: unknown) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('Failed to probe upstream site')
      )
    } finally {
      setIsProbing(false)
    }
  }

  const toggleModel = (name: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }

  const toggleHiddenGroup = (group: string) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) {
        next.delete(group)
      } else {
        next.add(group)
      }
      return next
    })
  }

  const searchedModels = (models: NewAPIProbeModel[]) => {
    const kw = searchKeyword.trim().toLowerCase()
    if (!kw) return models
    return models.filter((m) => m.model_name.toLowerCase().includes(kw))
  }

  const modelsOfGroup = (group: string, from?: NewAPIProbeModel[]) =>
    searchedModels(
      (from ?? probeResult?.models ?? []).filter((m) =>
        (m.enable_groups ?? []).includes(group)
      )
    )

  const selectAllInGroup = (group: string, from?: NewAPIProbeModel[]) => {
    setSelectedModels((prev) => {
      const next = new Set(prev)
      modelsOfGroup(group, from).forEach((m) => next.add(m.model_name))
      return next
    })
  }

  const setSaleOverrideField = (
    name: string,
    field: 'in' | 'out',
    raw: string
  ) => {
    const usd = saleInputToUSD(raw)
    setSaleOverrides((prev) => {
      const entry = { ...prev[name] }
      if (usd === undefined) {
        delete entry[field]
      } else {
        entry[field] = usd
      }
      const next = { ...prev }
      if (entry.in === undefined && entry.out === undefined) {
        delete next[name]
      } else {
        next[name] = entry
      }
      return next
    })
  }

  const setModelAlias = (upstreamName: string, alias: string) => {
    setModelAliases((prev) => {
      const next = { ...prev }
      if (!alias.trim() || alias.trim() === upstreamName) {
        delete next[upstreamName]
      } else {
        next[upstreamName] = alias.trim()
      }
      return next
    })
  }

  const enterFinalize = () => {
    if (selectedModels.size === 0) {
      toast.error(t('Please select at least one model'))
      return
    }
    if (!billingGroup) {
      toast.error(t('Please pick a billing group'))
      return
    }
    const host = probeResult
      ? new URL(probeResult.base_url).hostname
      : 'upstream'
    if (!channelName) {
      setChannelName(`${host} | ${billingGroup}`)
    }
    const allAnthropic =
      selectedModelObjects.length > 0 &&
      selectedModelObjects.every((m) =>
        (m.supported_endpoint_types ?? []).includes('anthropic')
      )
    setChannelType(allAnthropic ? CHANNEL_TYPE_ANTHROPIC : CHANNEL_TYPE_OPENAI)
    setStep('finalize')
  }

  const toggleLocalGroup = (group: string) => {
    setLocalGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) {
        next.delete(group)
      } else {
        next.add(group)
      }
      return next
    })
  }

  const handleSubmit = async () => {
    if (!probeResult) return
    if (!channelName.trim()) {
      toast.error(t('Please enter a channel name'))
      return
    }
    if (!channelKey.trim()) {
      toast.error(t('Please enter the API key used for relaying'))
      return
    }
    if (localGroups.size === 0) {
      toast.error(t('Please select at least one local group'))
      return
    }
    const localNames = selectedModelObjects.map((m) =>
      localNameFor(m.model_name)
    )
    const duplicates = localNames.filter(
      (n, i) => localNames.indexOf(n) !== i
    )
    if (duplicates.length > 0) {
      toast.error(
        t('Duplicate local model names: {{models}}', {
          models: [...new Set(duplicates)].join(', '),
        })
      )
      return
    }
    setIsSubmitting(true)
    try {
      const mapping: Record<string, string> = {}
      selectedModelObjects.forEach((m) => {
        const local = localNameFor(m.model_name)
        if (local !== m.model_name) {
          mapping[local] = m.model_name
        }
      })
      const createResp = await createChannel({
        mode: 'single',
        channel: {
          type: channelType,
          name: channelName.trim(),
          key: channelKey.trim(),
          base_url: probeResult.base_url,
          models: localNames.join(','),
          group: [...localGroups].join(','),
          model_mapping:
            Object.keys(mapping).length > 0
              ? JSON.stringify(mapping, null, 2)
              : '',
          status: 1,
          priority: 0,
          weight: 0,
        },
      })
      if (!createResp.success) {
        toast.error(createResp.message || t('Failed to create channel'))
        return
      }

      if (syncPricing) {
        let maps = extractRatioMaps(optionsResp?.data ?? [])
        selectedModelObjects.forEach((m) => {
          maps = applyModelPricing(
            { ...m, model_name: localNameFor(m.model_name) },
            saleInUSD(m),
            saleOutUSD(m),
            siteGroupRatio,
            maps
          )
        })
        for (const key of RATIO_OPTION_KEYS) {
          await updateSystemOption({
            key,
            value: JSON.stringify(maps[key], null, 2),
          })
        }
        queryClient.invalidateQueries({ queryKey: ['system-options'] })
      }

      queryClient.invalidateQueries({ queryKey: channelsQueryKeys.all })
      toast.success(
        syncPricing
          ? t('Channel created and pricing synced for {{count}} models', {
              count: selectedModels.size,
            })
          : t('Channel created with {{count}} models', {
              count: selectedModels.size,
            })
      )
      handleClose()
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : t('Failed to create channel')
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  const marginPercent = (sale: number, cost: number): number | null => {
    if (cost <= 0) return null
    return (sale / cost - 1) * 100
  }

  return {
    // step / dialog
    step,
    setStep,
    maximized,
    setMaximized,
    handleClose,
    // connect
    baseUrl,
    setBaseUrl,
    accessToken,
    setAccessToken,
    userId,
    setUserId,
    isProbing,
    handleProbe,
    probeResult,
    // select
    billingGroup,
    setBillingGroup,
    hiddenGroups,
    toggleHiddenGroup,
    searchKeyword,
    setSearchKeyword,
    selectedModels,
    toggleModel,
    selectAllInGroup,
    modelsOfGroup,
    markupInput,
    setMarkupInput,
    saleOverrides,
    setSaleOverrideField,
    setSaleOverrides,
    currency,
    setCurrency,
    upstreamRechargePrice,
    upstreamDisplayRate,
    ourRechargePrice,
    groupRatio,
    usableGroup,
    upstreamGroups,
    vendorSections,
    baseGroupRatioFor,
    saleInUSD,
    saleOutUSD,
    symbol,
    fmtCost,
    saleDisplayValue,
    marginPercent,
    siteGroupRatio,
    siteGroupRatioMap,
    enterFinalize,
    // finalize
    channelName,
    setChannelName,
    channelKey,
    setChannelKey,
    channelType,
    setChannelType,
    localGroups,
    toggleLocalGroup,
    availableLocalGroups,
    modelAliases,
    setModelAlias,
    localNameFor,
    selectedModelObjects,
    outOfBillingGroup,
    pricingConflicts,
    syncPricing,
    setSyncPricing,
    isSubmitting,
    handleSubmit,
  }
}

export type NewAPIOnboardController = ReturnType<typeof useNewAPIOnboard>
