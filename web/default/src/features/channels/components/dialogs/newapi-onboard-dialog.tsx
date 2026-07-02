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

/** Local ModelRatio bakes in the upstream group ratio so that a markup of 1
 *  makes our default-group selling price equal to our real upstream cost. */
function computeLocalRatios(
  model: NewAPIProbeModel,
  upstreamGroupRatio: number,
  markup: number,
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
    next.ModelPrice[name] = roundRatio(
      model.model_price * upstreamGroupRatio * markup
    )
    delete next.ModelRatio[name]
    delete next.CompletionRatio[name]
    delete next.CacheRatio[name]
    delete next.CreateCacheRatio[name]
    return next
  }
  next.ModelRatio[name] = roundRatio(
    model.model_ratio * upstreamGroupRatio * markup
  )
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

  const [selectedGroup, setSelectedGroup] = useState('')
  const [searchKeyword, setSearchKeyword] = useState('')
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())

  const [channelName, setChannelName] = useState('')
  const [channelKey, setChannelKey] = useState('')
  const [channelType, setChannelType] = useState(CHANNEL_TYPE_OPENAI)
  const [localGroups, setLocalGroups] = useState<Set<string>>(
    new Set(['default'])
  )
  const [syncPricing, setSyncPricing] = useState(true)
  const [markupInput, setMarkupInput] = useState('1')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const groupRatio = useMemo(
    () => probeResult?.group_ratio ?? {},
    [probeResult]
  )
  const usableGroup = probeResult?.usable_group ?? {}

  const upstreamGroups = useMemo(() => {
    const names = new Set<string>(Object.keys(groupRatio))
    probeResult?.models.forEach((m) =>
      (m.enable_groups ?? []).forEach((g) => names.add(g))
    )
    return Array.from(names).sort((a, b) => a.localeCompare(b))
  }, [probeResult, groupRatio])

  const selectedGroupRatio = groupRatio[selectedGroup] ?? 1

  const groupModels = useMemo(() => {
    if (!probeResult) return []
    if (!selectedGroup) return probeResult.models
    return probeResult.models.filter((m) =>
      (m.enable_groups ?? []).includes(selectedGroup)
    )
  }, [probeResult, selectedGroup])

  const filteredModels = useMemo(() => {
    const kw = searchKeyword.trim().toLowerCase()
    if (!kw) return groupModels
    return groupModels.filter((m) => m.model_name.toLowerCase().includes(kw))
  }, [groupModels, searchKeyword])

  const selectedModelObjects = useMemo(
    () =>
      (probeResult?.models ?? []).filter((m) =>
        selectedModels.has(m.model_name)
      ),
    [probeResult, selectedModels]
  )

  const markup = useMemo(() => {
    const parsed = Number(markupInput)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
  }, [markupInput])

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
        if (m.quota_type === 1) {
          const existing = currentRatioMaps.ModelPrice[m.model_name]
          if (existing === undefined) return false
          return (
            existing !==
            roundRatio(m.model_price * selectedGroupRatio * markup)
          )
        }
        const existing = currentRatioMaps.ModelRatio[m.model_name]
        if (existing === undefined) return false
        return (
          existing !== roundRatio(m.model_ratio * selectedGroupRatio * markup)
        )
      })
      .map((m) => m.model_name)
  }, [syncPricing, selectedModelObjects, currentRatioMaps, selectedGroupRatio, markup])

  const resetState = () => {
    setStep('connect')
    setBaseUrl('')
    setAccessToken('')
    setUserId('')
    setProbeResult(null)
    setSelectedGroup('')
    setSearchKeyword('')
    setSelectedModels(new Set())
    setChannelName('')
    setChannelKey('')
    setChannelType(CHANNEL_TYPE_OPENAI)
    setLocalGroups(new Set(['default']))
    setSyncPricing(true)
    setMarkupInput('1')
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
      setSelectedGroup('')
      setStep('select')
      toast.success(
        t('Found {{models}} models and {{groups}} groups', {
          models: resp.data.models.length,
          groups: Object.keys(resp.data.group_ratio ?? {}).length,
        })
      )
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : t('Failed to probe upstream site')
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

  const allFilteredSelected =
    filteredModels.length > 0 &&
    filteredModels.every((m) => selectedModels.has(m.model_name))

  const toggleAllFiltered = (checked: boolean) => {
    setSelectedModels((prev) => {
      const next = new Set(prev)
      filteredModels.forEach((m) => {
        if (checked) {
          next.add(m.model_name)
        } else {
          next.delete(m.model_name)
        }
      })
      return next
    })
  }

  const enterFinalize = () => {
    if (selectedModels.size === 0) {
      toast.error(t('Please select at least one model'))
      return
    }
    const host = probeResult
      ? new URL(probeResult.base_url).hostname
      : 'upstream'
    if (!channelName) {
      setChannelName(selectedGroup ? `${host} | ${selectedGroup}` : host)
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
          maps = computeLocalRatios(m, selectedGroupRatio, markup, maps)
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

  const formatUsd = (ratio: number) =>
    `$${(ratio * RATIO_TO_USD_PER_MILLION).toFixed(3)}`

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
        <Label htmlFor='newapi-user-id'>{t('Upstream user ID (optional)')}</Label>
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

  const renderSelectStep = () => (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-end gap-3'>
        <div className='space-y-1'>
          <Label>{t('Upstream group')}</Label>
          <Select
            value={selectedGroup || '__all__'}
            onValueChange={(v) =>
              setSelectedGroup(!v || v === '__all__' ? '' : v)
            }
          >
            <SelectTrigger className='w-72'>
              <SelectValue>{selectedGroup || t('All groups')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='__all__'>{t('All groups')}</SelectItem>
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
        </div>
        <div className='relative flex-1'>
          <Search className='text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2' />
          <Input
            placeholder={t('Search models...')}
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            className='pl-9'
          />
        </div>
      </div>

      {selectedGroup && (
        <p className='text-muted-foreground text-xs'>
          {usableGroup[selectedGroup] || selectedGroup} ·{' '}
          {t('Group ratio {{ratio}}, cost below already includes it', {
            ratio: selectedGroupRatio,
          })}
        </p>
      )}

      <div className='max-h-96 overflow-y-auto rounded-md border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className='w-10'>
                <Checkbox
                  checked={allFilteredSelected}
                  onCheckedChange={(checked) => toggleAllFiltered(!!checked)}
                />
              </TableHead>
              <TableHead>{t('Model')}</TableHead>
              <TableHead className='text-right'>{t('Model ratio')}</TableHead>
              <TableHead className='text-right'>
                {t('Completion ratio')}
              </TableHead>
              <TableHead className='text-right'>{t('Cache ratio')}</TableHead>
              <TableHead className='text-right'>
                {t('Cost / 1M input')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredModels.map((m) => (
              <TableRow
                key={m.model_name}
                className='cursor-pointer'
                onClick={() => toggleModel(m.model_name)}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selectedModels.has(m.model_name)}
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
                </TableCell>
                <TableCell className='text-right'>
                  {m.quota_type === 1
                    ? t('Per-call ${{price}}', { price: m.model_price })
                    : m.model_ratio}
                </TableCell>
                <TableCell className='text-right'>
                  {m.quota_type === 1 ? '-' : m.completion_ratio || '-'}
                </TableCell>
                <TableCell className='text-right'>
                  {m.quota_type === 1 ? '-' : m.cache_ratio || '-'}
                </TableCell>
                <TableCell className='text-right'>
                  {m.quota_type === 1
                    ? `$${roundRatio(m.model_price * selectedGroupRatio)}`
                    : formatUsd(m.model_ratio * selectedGroupRatio)}
                </TableCell>
              </TableRow>
            ))}
            {filteredModels.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className='text-muted-foreground py-8 text-center'
                >
                  {t('No models in this group')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className='bg-muted/50 rounded-lg border p-3 text-sm'>
        {t('{{n}} model(s) selected', { n: selectedModels.size })}
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
            { group: selectedGroup || t('any') }
          )}
        </p>
      </div>

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
                'Local model ratio = upstream model ratio x upstream group ratio ({{ratio}}) x markup',
                { ratio: selectedGroupRatio }
              )}
            </p>
          </div>
          <Switch
            id='newapi-sync-pricing'
            checked={syncPricing}
            onCheckedChange={setSyncPricing}
          />
        </div>
        {syncPricing && (
          <div className='flex items-center gap-2'>
            <Label htmlFor='newapi-markup' className='shrink-0'>
              {t('Markup multiplier')}
            </Label>
            <Input
              id='newapi-markup'
              className='max-w-24'
              value={markupInput}
              onChange={(e) => setMarkupInput(e.target.value)}
            />
            <span className='text-muted-foreground text-xs'>
              {t('1 = sell at cost (with default local group ratio 1)')}
            </span>
          </div>
        )}
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
          {t('Next: pricing & channel')}
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
          ? t('Enter the upstream site address to discover its groups, models and pricing')
          : step === 'select'
            ? t('Pick an upstream group and select the models to onboard')
            : t('Set channel info and local pricing')
      }
      contentClassName='max-w-4xl'
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
