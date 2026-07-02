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
import { Loader2, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  getSystemOptions,
  updateSystemOption,
} from '@/features/system-settings/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Dialog } from '@/components/dialog'
import { createChannel, getGroups, probeNewAPIUpstream } from '../../api'
import { channelsQueryKeys } from '../../lib'
import type { NewAPIProbeModel, NewAPIProbeResult } from '../../types'

const CHANNEL_TYPE_OPENAI = 1
const CHANNEL_TYPE_ANTHROPIC = 14
// ratio 1 == $0.002 / 1K tokens == $2 / 1M tokens
const RATIO_TO_USD_PER_MILLION = 2

type WizardStep = 'connect' | 'select' | 'finalize'

type NewAPIOnboardDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type RatioOptionMaps = {
  ModelRatio: Record<string, number>
  CompletionRatio: Record<string, number>
  CacheRatio: Record<string, number>
  CreateCacheRatio: Record<string, number>
  ModelPrice: Record<string, number>
}

const RATIO_OPTION_KEYS = [
  'ModelRatio',
  'CompletionRatio',
  'CacheRatio',
  'CreateCacheRatio',
  'ModelPrice',
] as const

function parseJsonRecord(raw: string | undefined): Record<string, number> {
  try {
    return JSON.parse(raw || '{}') as Record<string, number>
  } catch {
    return {}
  }
}

function extractRatioMaps(
  options: Array<{ key: string; value: string }>
): RatioOptionMaps {
  const byKey = new Map(options.map((o) => [o.key, o.value]))
  return {
    ModelRatio: parseJsonRecord(byKey.get('ModelRatio')),
    CompletionRatio: parseJsonRecord(byKey.get('CompletionRatio')),
    CacheRatio: parseJsonRecord(byKey.get('CacheRatio')),
    CreateCacheRatio: parseJsonRecord(byKey.get('CreateCacheRatio')),
    ModelPrice: parseJsonRecord(byKey.get('ModelPrice')),
  }
}

function roundRatio(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** sale is $/1M input tokens for ratio-billed models, $/call for price-billed. */
function applyModelPricing(
  model: NewAPIProbeModel,
  sale: number,
  maps: RatioOptionMaps
): RatioOptionMaps {
  const name = model.model_name
  const next: RatioOptionMaps = {
    ModelRatio: { ...maps.ModelRatio },
    CompletionRatio: { ...maps.CompletionRatio },
    CacheRatio: { ...maps.CacheRatio },
    CreateCacheRatio: { ...maps.CreateCacheRatio },
    ModelPrice: { ...maps.ModelPrice },
  }
  if (model.quota_type === 1) {
    next.ModelPrice[name] = roundRatio(sale)
    delete next.ModelRatio[name]
    delete next.CompletionRatio[name]
    delete next.CacheRatio[name]
    delete next.CreateCacheRatio[name]
    return next
  }
  next.ModelRatio[name] = roundRatio(sale / RATIO_TO_USD_PER_MILLION)
  if (model.completion_ratio > 0) {
    next.CompletionRatio[name] = roundRatio(model.completion_ratio)
  }
  if (model.cache_ratio > 0) {
    next.CacheRatio[name] = roundRatio(model.cache_ratio)
  }
  if (model.create_cache_ratio > 0) {
    next.CreateCacheRatio[name] = roundRatio(model.create_cache_ratio)
  }
  delete next.ModelPrice[name]
  return next
}

export function NewAPIOnboardDialog({
  open,
  onOpenChange,
}: NewAPIOnboardDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [step, setStep] = useState<WizardStep>('connect')
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
  const [saleOverrides, setSaleOverrides] = useState<Record<string, number>>(
    {}
  )

  const [channelName, setChannelName] = useState('')
  const [channelKey, setChannelKey] = useState('')
  const [channelType, setChannelType] = useState(CHANNEL_TYPE_OPENAI)
  const [localGroups, setLocalGroups] = useState<Set<string>>(
    new Set(['default'])
  )
  const [syncPricing, setSyncPricing] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)

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
    return Array.from(names).sort((a, b) => a.localeCompare(b))
  }, [probeResult, groupRatio])

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

  // Cost basis for the default local price: the billing group when the model
  // belongs to it, otherwise the model's own (first) group.
  const baseGroupRatioFor = (m: NewAPIProbeModel): number => {
    const groups = m.enable_groups ?? []
    if (billingGroup && groups.includes(billingGroup)) {
      return groupRatio[billingGroup] ?? 1
    }
    const own = groups[0]
    return (own && groupRatio[own]) || 1
  }

  const defaultSaleFor = (m: NewAPIProbeModel): number => {
    if (m.quota_type === 1) {
      return m.model_price * baseGroupRatioFor(m) * markup
    }
    return (
      m.model_ratio * baseGroupRatioFor(m) * RATIO_TO_USD_PER_MILLION * markup
    )
  }

  const effectiveSaleFor = (m: NewAPIProbeModel): number =>
    saleOverrides[m.model_name] ?? defaultSaleFor(m)

  const searchedModels = (models: NewAPIProbeModel[]) => {
    const kw = searchKeyword.trim().toLowerCase()
    if (!kw) return models
    return models.filter((m) => m.model_name.toLowerCase().includes(kw))
  }

  const modelsOfGroup = (group: string) =>
    searchedModels(
      (probeResult?.models ?? []).filter((m) =>
        (m.enable_groups ?? []).includes(group)
      )
    )

  const outOfBillingGroup = useMemo(
    () =>
      billingGroup
        ? selectedModelObjects
            .filter((m) => !(m.enable_groups ?? []).includes(billingGroup))
            .map((m) => m.model_name)
        : [],
    [selectedModelObjects, billingGroup]
  )

  const { data: groupsResp } = useQuery({
    queryKey: ['user-groups'],
    queryFn: getGroups,
    enabled: open && step === 'finalize',
  })
  const availableLocalGroups = groupsResp?.data ?? ['default']

  const { data: optionsResp } = useQuery({
    queryKey: ['system-options'],
    queryFn: getSystemOptions,
    enabled: open && step === 'finalize',
  })
  const currentRatioMaps = useMemo(
    () => extractRatioMaps(optionsResp?.data ?? []),
    [optionsResp]
  )

  const pricingConflicts = useMemo(() => {
    if (!syncPricing) return []
    return selectedModelObjects
      .filter((m) => {
        const sale = effectiveSaleFor(m)
        if (m.quota_type === 1) {
          const existing = currentRatioMaps.ModelPrice[m.model_name]
          return existing !== undefined && existing !== roundRatio(sale)
        }
        const existing = currentRatioMaps.ModelRatio[m.model_name]
        return (
          existing !== undefined &&
          existing !== roundRatio(sale / RATIO_TO_USD_PER_MILLION)
        )
      })
      .map((m) => m.model_name)
    // effectiveSaleFor depends on saleOverrides/markup/billingGroup captured below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    syncPricing,
    selectedModelObjects,
    currentRatioMaps,
    saleOverrides,
    markup,
    billingGroup,
    groupRatio,
  ])

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

  const selectAllInGroup = (group: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev)
      modelsOfGroup(group).forEach((m) => next.add(m.model_name))
      return next
    })
  }

  const setSaleOverride = (name: string, raw: string) => {
    const parsed = Number(raw)
    setSaleOverrides((prev) => {
      const next = { ...prev }
      if (Number.isFinite(parsed) && parsed >= 0) {
        next[name] = parsed
      } else {
        delete next[name]
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
    setIsSubmitting(true)
    try {
      const createResp = await createChannel({
        mode: 'single',
        channel: {
          type: channelType,
          name: channelName.trim(),
          key: channelKey.trim(),
          base_url: probeResult.base_url,
          models: Array.from(selectedModels).join(','),
          group: Array.from(localGroups).join(','),
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
          maps = applyModelPricing(m, effectiveSaleFor(m), maps)
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

  const formatUsd = (value: number) => `$${roundRatio(value)}`

  const marginPercent = (sale: number, cost: number): number | null => {
    if (cost <= 0) return null
    return (sale / cost - 1) * 100
  }

  const renderConnectStep = () => (
    <div className='space-y-4'>
      <div className='space-y-2'>
        <Label htmlFor='newapi-base-url'>{t('Upstream site address')}</Label>
        <Input
          id='newapi-base-url'
          placeholder='https://api.example.com'
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <p className='text-muted-foreground text-xs'>
          {t(
            'Any NewAPI-compatible site. Paste any page URL of the site; only the domain is used.'
          )}
        </p>
      </div>
      <div className='space-y-2'>
        <Label htmlFor='newapi-access-token'>
          {t('System access token (optional)')}
        </Label>
        <Input
          id='newapi-access-token'
          placeholder={t('Only needed when the pricing page requires login')}
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
        />
      </div>
      <div className='space-y-2'>
        <Label htmlFor='newapi-user-id'>
          {t('Upstream user ID (optional)')}
        </Label>
        <Input
          id='newapi-user-id'
          placeholder='1'
          className='max-w-32'
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        />
      </div>
    </div>
  )

  const renderModelRow = (m: NewAPIProbeModel, group: string) => {
    const isSel = selectedModels.has(m.model_name)
    const cost =
      m.quota_type === 1
        ? m.model_price * (groupRatio[group] ?? 1)
        : m.model_ratio * (groupRatio[group] ?? 1) * RATIO_TO_USD_PER_MILLION
    const sale = effectiveSaleFor(m)
    const overridden = saleOverrides[m.model_name] !== undefined
    const margin = marginPercent(sale, cost)
    return (
      <TableRow
        key={`${group}:${m.model_name}`}
        className={cn('cursor-pointer', isSel && 'bg-primary/5')}
        onClick={() => toggleModel(m.model_name)}
      >
        <TableCell onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={isSel}
            onCheckedChange={() => toggleModel(m.model_name)}
          />
        </TableCell>
        <TableCell className='font-mono text-xs'>
          {m.model_name}
          {(m.supported_endpoint_types ?? []).includes('anthropic') && (
            <Badge variant='outline' className='ml-2'>
              anthropic
            </Badge>
          )}
          {m.quota_type === 1 && (
            <Badge variant='secondary' className='ml-2'>
              {t('per-call')}
            </Badge>
          )}
        </TableCell>
        <TableCell className='text-right'>
          {m.quota_type === 1 ? `$${m.model_price}` : m.model_ratio}
        </TableCell>
        <TableCell className='text-right'>
          {m.quota_type === 1 ? '-' : m.completion_ratio || '-'}
        </TableCell>
        <TableCell className='text-right font-medium'>
          {formatUsd(cost)}
        </TableCell>
        <TableCell
          className='text-right'
          onClick={(e) => e.stopPropagation()}
        >
          <span className='inline-flex items-center gap-1.5'>
            <Input
              type='number'
              step='0.001'
              min='0'
              className={cn(
                'h-7 w-24 text-right font-mono text-xs',
                overridden && 'border-amber-500 bg-amber-50 dark:bg-amber-950'
              )}
              value={roundRatio(sale)}
              onChange={(e) => setSaleOverride(m.model_name, e.target.value)}
            />
            {margin !== null && (
              <span
                className={cn(
                  'w-12 text-xs',
                  margin >= 0
                    ? 'text-green-600 dark:text-green-500'
                    : 'text-red-600 dark:text-red-500'
                )}
              >
                {margin >= 0 ? '+' : ''}
                {margin.toFixed(0)}%
              </span>
            )}
          </span>
        </TableCell>
      </TableRow>
    )
  }

  const renderGroupSection = (group: string) => {
    const models = modelsOfGroup(group)
    if (models.length === 0) return null
    return (
      <div key={group} className='overflow-hidden rounded-md border'>
        <div className='bg-muted/60 flex flex-wrap items-center gap-2 px-3 py-2'>
          <span className='text-sm font-semibold'>{group}</span>
          <Badge variant='secondary'>x{groupRatio[group] ?? 1}</Badge>
          {group === billingGroup && (
            <Badge>{t('Billing group')}</Badge>
          )}
          <span className='text-muted-foreground max-w-72 truncate text-xs'>
            {usableGroup[group] || ''}
          </span>
          <span className='text-muted-foreground ml-auto text-xs'>
            {t('{{count}} models', { count: models.length })}
          </span>
          <Button
            variant='outline'
            size='sm'
            className='h-6 px-2 text-xs'
            onClick={() => selectAllInGroup(group)}
          >
            {t('Select all in group')}
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className='w-10' />
              <TableHead>{t('Model')}</TableHead>
              <TableHead className='text-right'>{t('Model ratio')}</TableHead>
              <TableHead className='text-right'>
                {t('Completion ratio')}
              </TableHead>
              <TableHead className='text-right'>
                {t('Cost / 1M input')}
              </TableHead>
              <TableHead className='text-right'>
                {t('Local price / 1M (editable)')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>{models.map((m) => renderModelRow(m, group))}</TableBody>
        </Table>
      </div>
    )
  }

  const renderSelectStep = () => (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-3'>
        <div className='flex items-center gap-2'>
          <Label className='shrink-0'>{t('Billing group')}</Label>
          <Select
            value={billingGroup}
            onValueChange={(v) => {
              if (v) {
                setBillingGroup(v)
                setSaleOverrides({})
              }
            }}
          >
            <SelectTrigger className='w-64'>
              <SelectValue>{billingGroup}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {upstreamGroups.map((g) => (
                <SelectItem key={g} value={g}>
                  <span className='flex items-center gap-2'>
                    <span>{g}</span>
                    <Badge variant='secondary'>x{groupRatio[g] ?? 1}</Badge>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Tooltip>
            <TooltipTrigger
              render={
                <span className='text-muted-foreground cursor-help text-xs underline decoration-dotted'>
                  ?
                </span>
              }
            />
            <TooltipContent className='max-w-72'>
              {t(
                'The relay token must belong to this group. Models picked outside it are still billed by this group upstream, so their real cost may differ.'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className='flex items-center gap-2'>
          <Label htmlFor='newapi-markup' className='shrink-0'>
            {t('Global markup')}
          </Label>
          <Input
            id='newapi-markup'
            className='h-8 w-20'
            value={markupInput}
            onChange={(e) => {
              setMarkupInput(e.target.value)
              setSaleOverrides({})
            }}
          />
        </div>
        <div className='relative min-w-44 flex-1'>
          <Search className='text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2' />
          <Input
            placeholder={t('Search models...')}
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            className='h-8 pl-9'
          />
        </div>
      </div>

      <div className='flex flex-wrap gap-1.5'>
        {upstreamGroups.map((g) => {
          const visible = !hiddenGroups.has(g)
          return (
            <button
              key={g}
              type='button'
              onClick={() => toggleHiddenGroup(g)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                visible
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'text-muted-foreground bg-transparent'
              )}
            >
              {visible ? '✓ ' : ''}
              {g}{' '}
              <span className='opacity-70'>x{groupRatio[g] ?? 1}</span>
            </button>
          )
        })}
      </div>

      <div className='max-h-96 space-y-3 overflow-y-auto pr-1'>
        {upstreamGroups
          .filter((g) => !hiddenGroups.has(g))
          .map((g) => renderGroupSection(g))}
      </div>

      <div className='bg-muted/50 flex flex-wrap items-center gap-4 rounded-lg border p-3 text-sm'>
        <span>{t('{{n}} model(s) selected', { n: selectedModels.size })}</span>
        <span className='text-muted-foreground text-xs'>
          {t(
            'Local price defaults to cost x markup; edited prices are highlighted'
          )}
        </span>
      </div>
    </div>
  )

  const renderFinalizeStep = () => (
    <div className='space-y-4'>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
        <div className='space-y-2'>
          <Label htmlFor='newapi-channel-name'>{t('Channel name')}</Label>
          <Input
            id='newapi-channel-name'
            value={channelName}
            onChange={(e) => setChannelName(e.target.value)}
          />
        </div>
        <div className='space-y-2'>
          <Label>{t('Channel type')}</Label>
          <Select
            value={String(channelType)}
            onValueChange={(v) => setChannelType(Number(v))}
          >
            <SelectTrigger className='w-full'>
              <SelectValue>
                {channelType === CHANNEL_TYPE_ANTHROPIC
                  ? 'Anthropic (Claude)'
                  : 'OpenAI'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={String(CHANNEL_TYPE_OPENAI)}>
                OpenAI
              </SelectItem>
              <SelectItem value={String(CHANNEL_TYPE_ANTHROPIC)}>
                Anthropic (Claude)
              </SelectItem>
            </SelectContent>
          </Select>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Anthropic is pre-selected when every selected model supports the anthropic endpoint'
            )}
          </p>
        </div>
      </div>

      <div className='space-y-2'>
        <Label htmlFor='newapi-channel-key'>{t('Relay API key')}</Label>
        <Input
          id='newapi-channel-key'
          placeholder='sk-...'
          value={channelKey}
          onChange={(e) => setChannelKey(e.target.value)}
        />
        <p className='text-muted-foreground text-xs'>
          {t(
            'Create an API token on the upstream site (bound to group {{group}}) and paste it here. The system access token cannot be used for relaying.',
            { group: billingGroup || t('any') }
          )}
        </p>
      </div>

      {outOfBillingGroup.length > 0 && (
        <p className='text-xs text-amber-600 dark:text-amber-500'>
          {t(
            '{{count}} selected models are outside the billing group and will still be billed via it upstream: {{models}}',
            {
              count: outOfBillingGroup.length,
              models: outOfBillingGroup.join(', '),
            }
          )}
        </p>
      )}

      <div className='space-y-2'>
        <Label>{t('Local groups allowed to use this channel')}</Label>
        <div className='flex flex-wrap gap-3 rounded-md border p-3'>
          {availableLocalGroups.map((g) => (
            <label key={g} className='flex items-center gap-1.5 text-sm'>
              <Checkbox
                checked={localGroups.has(g)}
                onCheckedChange={() => toggleLocalGroup(g)}
              />
              {g}
            </label>
          ))}
        </div>
      </div>

      <div className='space-y-3 rounded-md border p-3'>
        <div className='flex items-center justify-between'>
          <div>
            <Label htmlFor='newapi-sync-pricing'>
              {t('Write model pricing to local ratio settings')}
            </Label>
            <p className='text-muted-foreground text-xs'>
              {t(
                'Prices set in the previous step are written as local model ratios'
              )}
            </p>
          </div>
          <Switch
            id='newapi-sync-pricing'
            checked={syncPricing}
            onCheckedChange={setSyncPricing}
          />
        </div>
        {syncPricing && pricingConflicts.length > 0 && (
          <p className='text-xs text-amber-600 dark:text-amber-500'>
            {t(
              '{{count}} models already have different local pricing and will be overwritten: {{models}}',
              {
                count: pricingConflicts.length,
                models: pricingConflicts.join(', '),
              }
            )}
          </p>
        )}
      </div>

      <div className='bg-muted/50 max-h-40 overflow-y-auto rounded-lg border p-3 text-xs'>
        <p className='mb-1 font-medium'>
          {t('{{n}} model(s) selected', { n: selectedModels.size })}
        </p>
        <p className='text-muted-foreground font-mono'>
          {Array.from(selectedModels).join(', ')}
        </p>
      </div>
    </div>
  )

  const footer = (
    <>
      <Button variant='outline' onClick={handleClose} disabled={isSubmitting}>
        {t('Cancel')}
      </Button>
      {step !== 'connect' && (
        <Button
          variant='outline'
          disabled={isSubmitting}
          onClick={() => setStep(step === 'finalize' ? 'select' : 'connect')}
        >
          {t('Back')}
        </Button>
      )}
      {step === 'connect' && (
        <Button onClick={handleProbe} disabled={isProbing}>
          {isProbing && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
          {isProbing ? t('Probing...') : t('Probe upstream')}
        </Button>
      )}
      {step === 'select' && (
        <Button onClick={enterFinalize} disabled={selectedModels.size === 0}>
          {t('Next: channel info')}
        </Button>
      )}
      {step === 'finalize' && (
        <Button onClick={handleSubmit} disabled={isSubmitting}>
          {isSubmitting && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
          {isSubmitting ? t('Creating...') : t('Create Channel')}
        </Button>
      )}
    </>
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && handleClose()}
      title={t('Onboard NewAPI upstream')}
      description={
        step === 'connect'
          ? t(
              'Enter the upstream site address to discover its groups, models and pricing'
            )
          : step === 'select'
            ? t(
                'All groups at a glance: filter groups, tick models and set local prices'
              )
            : t('Set channel info and confirm pricing')
      }
      contentClassName='max-w-5xl'
      contentHeight='auto'
      bodyClassName='space-y-4'
      footer={footer}
    >
      {step === 'connect' && renderConnectStep()}
      {step === 'select' && renderSelectStep()}
      {step === 'finalize' && renderFinalizeStep()}
    </Dialog>
  )
}
