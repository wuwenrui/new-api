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
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'

import { SettingsSwitchField } from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'

const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

export type PeakRatioDefaults = {
  'peak_ratio_setting.enabled': boolean
  'peak_ratio_setting.weekend_enabled': boolean
  'peak_ratio_setting.multiplier': number
  'peak_ratio_setting.timezone': string
  'peak_ratio_setting.models': string
  'peak_ratio_setting.windows': string
}

type ModelRow = { id: number; value: string }
type WindowRow = { id: number; start: string; end: string }

function parseModels(json: string): string[] {
  try {
    const parsed = JSON.parse(json || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

function parseWindows(json: string): Array<{ start: string; end: string }> {
  try {
    const parsed = JSON.parse(json || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null
      )
      .map((item) => ({
        start: typeof item.start === 'string' ? item.start : '',
        end: typeof item.end === 'string' ? item.end : '',
      }))
  } catch {
    return []
  }
}

function serializeModels(rows: ModelRow[]): string {
  return JSON.stringify(
    rows.map((row) => row.value.trim()).filter((value) => value.length > 0)
  )
}

function serializeWindows(rows: WindowRow[]): string {
  return JSON.stringify(
    rows.map((row) => ({ start: row.start.trim(), end: row.end.trim() }))
  )
}

interface Props {
  defaultValues: PeakRatioDefaults
}

export function PeakRatioCard(props: Props) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const rowIdRef = useRef(0)
  const nextRowId = () => {
    rowIdRef.current += 1
    return rowIdRef.current
  }

  const buildModelRows = (json: string): ModelRow[] =>
    parseModels(json).map((value) => ({ id: nextRowId(), value }))
  const buildWindowRows = (json: string): WindowRow[] =>
    parseWindows(json).map((win) => ({ id: nextRowId(), ...win }))

  const [enabled, setEnabled] = useState(
    props.defaultValues['peak_ratio_setting.enabled']
  )
  const [weekendEnabled, setWeekendEnabled] = useState(
    props.defaultValues['peak_ratio_setting.weekend_enabled']
  )
  const [multiplier, setMultiplier] = useState(
    String(props.defaultValues['peak_ratio_setting.multiplier'])
  )
  const [timezone, setTimezone] = useState(
    props.defaultValues['peak_ratio_setting.timezone']
  )
  const [models, setModels] = useState<ModelRow[]>(() =>
    buildModelRows(props.defaultValues['peak_ratio_setting.models'])
  )
  const [windows, setWindows] = useState<WindowRow[]>(() =>
    buildWindowRows(props.defaultValues['peak_ratio_setting.windows'])
  )

  useEffect(() => {
    setEnabled(props.defaultValues['peak_ratio_setting.enabled'])
    setWeekendEnabled(props.defaultValues['peak_ratio_setting.weekend_enabled'])
    setMultiplier(String(props.defaultValues['peak_ratio_setting.multiplier']))
    setTimezone(props.defaultValues['peak_ratio_setting.timezone'])
    setModels(buildModelRows(props.defaultValues['peak_ratio_setting.models']))
    setWindows(
      buildWindowRows(props.defaultValues['peak_ratio_setting.windows'])
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.defaultValues])

  const addModel = () =>
    setModels((prev) => [...prev, { id: nextRowId(), value: '' }])
  const updateModel = (id: number, value: string) =>
    setModels((prev) =>
      prev.map((row) => (row.id === id ? { ...row, value } : row))
    )
  const removeModel = (id: number) =>
    setModels((prev) => prev.filter((row) => row.id !== id))

  const addWindow = () =>
    setWindows((prev) => [...prev, { id: nextRowId(), start: '', end: '' }])
  const updateWindow = (id: number, patch: Partial<WindowRow>) =>
    setWindows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, ...patch } : row))
    )
  const removeWindow = (id: number) =>
    setWindows((prev) => prev.filter((row) => row.id !== id))

  const handleSave = async () => {
    const parsedMultiplier = Number(multiplier.trim())
    if (!Number.isFinite(parsedMultiplier) || parsedMultiplier < 1) {
      toast.error(t('Peak multiplier must be at least 1'))
      return
    }
    for (const win of windows) {
      if (
        !HHMM_PATTERN.test(win.start.trim()) ||
        !HHMM_PATTERN.test(win.end.trim())
      ) {
        toast.error(t('Time must be in HH:MM format'))
        return
      }
    }

    const updates: Array<{ key: string; value: boolean | number | string }> = []

    if (enabled !== props.defaultValues['peak_ratio_setting.enabled']) {
      updates.push({ key: 'peak_ratio_setting.enabled', value: enabled })
    }
    if (
      weekendEnabled !==
      props.defaultValues['peak_ratio_setting.weekend_enabled']
    ) {
      updates.push({
        key: 'peak_ratio_setting.weekend_enabled',
        value: weekendEnabled,
      })
    }
    if (
      parsedMultiplier !== props.defaultValues['peak_ratio_setting.multiplier']
    ) {
      updates.push({
        key: 'peak_ratio_setting.multiplier',
        value: parsedMultiplier,
      })
    }
    if (
      timezone.trim() !== props.defaultValues['peak_ratio_setting.timezone']
    ) {
      updates.push({
        key: 'peak_ratio_setting.timezone',
        value: timezone.trim(),
      })
    }

    const modelsJson = serializeModels(models)
    const origModelsJson = serializeModels(
      buildModelRows(props.defaultValues['peak_ratio_setting.models'])
    )
    if (modelsJson !== origModelsJson) {
      updates.push({ key: 'peak_ratio_setting.models', value: modelsJson })
    }

    const windowsJson = serializeWindows(windows)
    const origWindowsJson = serializeWindows(
      buildWindowRows(props.defaultValues['peak_ratio_setting.windows'])
    )
    if (windowsJson !== origWindowsJson) {
      updates.push({ key: 'peak_ratio_setting.windows', value: windowsJson })
    }

    if (updates.length === 0) {
      toast.info(t('No changes'))
      return
    }

    for (const update of updates) {
      await updateOption.mutateAsync(update)
    }
  }

  return (
    <SettingsSection title={t('Peak Pricing')}>
      <SettingsPageFormActions
        onSave={handleSave}
        isSaving={updateOption.isPending}
      />

      <SettingsSwitchField
        checked={enabled}
        onCheckedChange={setEnabled}
        label={t('Enable peak pricing')}
        description={t(
          'When enabled, matched models are charged at an increased rate during peak hours.'
        )}
      />

      <SettingsSwitchField
        checked={weekendEnabled}
        onCheckedChange={setWeekendEnabled}
        label={t('Apply peak pricing on weekends')}
        description={t(
          'When disabled, peak pricing does not apply on Saturdays or Sundays.'
        )}
      />

      <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
        <div className='grid gap-1.5'>
          <Label>{t('Peak multiplier')}</Label>
          <Input
            type='number'
            min={1}
            step={0.1}
            value={multiplier}
            onChange={(event) => setMultiplier(event.target.value)}
          />
          <p className='text-muted-foreground text-xs'>
            {t('Billing rate multiplier during peak hours. 2 means double.')}
          </p>
        </div>
        <div className='grid gap-1.5'>
          <Label>{t('Timezone')}</Label>
          <Input
            value={timezone}
            placeholder='Asia/Shanghai'
            onChange={(event) => setTimezone(event.target.value)}
          />
          <p className='text-muted-foreground text-xs'>
            {t('Leave empty to use Beijing time.')}
          </p>
        </div>
      </div>

      <Separator />

      <div className='grid gap-2'>
        <div className='flex items-center justify-between'>
          <Label>{t('Effective models')}</Label>
          <Button variant='outline' size='sm' onClick={addModel}>
            <Plus className='mr-1 h-3 w-3' />
            {t('Add model prefix')}
          </Button>
        </div>
        <p className='text-muted-foreground text-xs'>
          {t(
            'Model name prefixes. For example, deepseek matches all models starting with deepseek.'
          )}
        </p>
        {models.map((row) => (
          <div key={row.id} className='flex items-center gap-2'>
            <Input
              value={row.value}
              placeholder='deepseek'
              onChange={(event) => updateModel(row.id, event.target.value)}
            />
            <Button
              variant='ghost'
              size='icon'
              className='h-9 w-9 shrink-0'
              onClick={() => removeModel(row.id)}
              title={t('Remove')}
            >
              <Trash2 className='h-4 w-4' />
            </Button>
          </div>
        ))}
      </div>

      <Separator />

      <div className='grid gap-2'>
        <div className='flex items-center justify-between'>
          <Label>{t('Peak hours')}</Label>
          <Button variant='outline' size='sm' onClick={addWindow}>
            <Plus className='mr-1 h-3 w-3' />
            {t('Add time window')}
          </Button>
        </div>
        <p className='text-muted-foreground text-xs'>
          {t('Beijing time peak windows. Start inclusive, end exclusive.')}
        </p>
        {windows.map((row) => (
          <div key={row.id} className='flex items-center gap-2'>
            <Input
              type='time'
              className='w-32'
              aria-label={t('Start')}
              value={row.start}
              onChange={(event) =>
                updateWindow(row.id, { start: event.target.value })
              }
            />
            <span className='text-muted-foreground'>-</span>
            <Input
              type='time'
              className='w-32'
              aria-label={t('End')}
              value={row.end}
              onChange={(event) =>
                updateWindow(row.id, { end: event.target.value })
              }
            />
            <Button
              variant='ghost'
              size='icon'
              className='h-9 w-9 shrink-0'
              onClick={() => removeWindow(row.id)}
              title={t('Remove')}
            >
              <Trash2 className='h-4 w-4' />
            </Button>
          </div>
        ))}
      </div>
    </SettingsSection>
  )
}
