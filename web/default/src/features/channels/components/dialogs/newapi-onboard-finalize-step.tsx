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
import { useTranslation } from 'react-i18next'

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
import { cn } from '@/lib/utils'

import {
  CHANNEL_TYPE_ANTHROPIC,
  CHANNEL_TYPE_OPENAI,
  type NewAPIOnboardController,
} from '../../hooks/use-newapi-onboard'

type Props = { ctl: NewAPIOnboardController }

export function NewAPIOnboardFinalizeStep({ ctl }: Props) {
  const { t } = useTranslation()

  return (
    <div className='space-y-4'>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
        <div className='space-y-2'>
          <Label htmlFor='newapi-channel-name'>{t('Channel name')}</Label>
          <Input
            id='newapi-channel-name'
            value={ctl.channelName}
            onChange={(e) => ctl.setChannelName(e.target.value)}
          />
        </div>
        <div className='space-y-2'>
          <Label>{t('Channel type')}</Label>
          <Select
            value={String(ctl.channelType)}
            onValueChange={(v) => ctl.setChannelType(Number(v))}
          >
            <SelectTrigger className='w-full'>
              <SelectValue>
                {ctl.channelType === CHANNEL_TYPE_ANTHROPIC
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
          value={ctl.channelKey}
          onChange={(e) => ctl.setChannelKey(e.target.value)}
        />
        <p className='text-muted-foreground text-xs'>
          {ctl.source === 'sub2api'
            ? t(
                'Paste the API key from this Sub2API site. It is used only for relay requests.'
              )
            : t(
                'Create an API token on the upstream site (bound to group {{group}}) and paste it here. The system access token cannot be used for relaying.',
                { group: ctl.billingGroup || t('any') }
              )}
        </p>
      </div>

      {ctl.outOfBillingGroup.length > 0 && (
        <p className='text-xs text-amber-600 dark:text-amber-500'>
          {t(
            '{{count}} selected models are outside the billing group and will still be billed via it upstream: {{models}}',
            {
              count: ctl.outOfBillingGroup.length,
              models: ctl.outOfBillingGroup.join(', '),
            }
          )}
        </p>
      )}

      <div className='space-y-2'>
        <Label>{t('Local groups allowed to use this channel')}</Label>
        <div className='flex flex-wrap gap-3 rounded-md border p-3'>
          {ctl.availableLocalGroups.map((g) => (
            <label key={g} className='flex items-center gap-1.5 text-sm'>
              <Checkbox
                checked={ctl.localGroups.has(g)}
                onCheckedChange={() => ctl.toggleLocalGroup(g)}
              />
              {g}
              <span className='text-muted-foreground text-xs'>
                x{ctl.siteGroupRatioMap[g] ?? 1}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className='space-y-2'>
        <Label>{t('Model names on our site (mapping)')}</Label>
        <p className='text-muted-foreground text-xs'>
          {t(
            'Rename a model for our site if you want; requests are mapped back to the upstream name automatically. Default keeps the original name.'
          )}
        </p>
        <div className='max-h-56 overflow-y-auto rounded-md border'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Upstream model')}</TableHead>
                <TableHead>{t('Local model name (editable)')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ctl.selectedModelObjects.map((m) => {
                const alias = ctl.modelAliases[m.model_name] ?? ''
                const mapped = alias && alias !== m.model_name
                return (
                  <TableRow key={m.model_name}>
                    <TableCell className='font-mono text-xs'>
                      {m.model_name}
                    </TableCell>
                    <TableCell>
                      <Input
                        className={cn(
                          'h-7 font-mono text-xs',
                          mapped &&
                            'border-blue-400 bg-blue-50 dark:bg-blue-950'
                        )}
                        placeholder={m.model_name}
                        value={alias}
                        onChange={(e) =>
                          ctl.setModelAlias(m.model_name, e.target.value)
                        }
                      />
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className='space-y-3 rounded-md border p-3'>
        <div className='flex items-center justify-between'>
          <div>
            <Label htmlFor='newapi-sync-pricing'>
              {t('Write model pricing to local ratio settings')}
            </Label>
            <p className='text-muted-foreground text-xs'>
              {ctl.source === 'sub2api'
                ? t(
                    'Sale prices are written as per-model billing expressions; context tiers and cache prices follow the latest models.dev catalog.'
                  )
                : t(
                    'Sale prices are end-user prices; written ratio = price / anchor / our group ratio (x{{ratio}})',
                    { ratio: ctl.siteGroupRatio }
                  )}
            </p>
          </div>
          <Switch
            id='newapi-sync-pricing'
            checked={ctl.syncPricing}
            onCheckedChange={ctl.setSyncPricing}
          />
        </div>
        {ctl.syncPricing && ctl.pricingConflicts.length > 0 && (
          <p className='text-xs text-amber-600 dark:text-amber-500'>
            {t(
              '{{count}} models already have different local pricing and will be overwritten: {{models}}',
              {
                count: ctl.pricingConflicts.length,
                models: ctl.pricingConflicts.join(', '),
              }
            )}
          </p>
        )}
      </div>
    </div>
  )
}
