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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import {
  getOptionValue,
  useSystemOptions,
} from '@/features/system-settings/hooks/use-system-options'
import { useUpdateOption } from '@/features/system-settings/hooks/use-update-option'

import { SUBSCRIPTION_FEATURE_ITEMS } from '../../feature-catalog'
import { useSubscriptions } from '../subscriptions-provider'

const ACCESS_POLICIES_OPTION_KEY = 'subscription_feature_setting.access_policies'
const POLICY_FREE = 'free'

function parsePolicies(raw: string): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
  } catch {
    /* fall through to empty policies */
  }
  return {}
}

export function FeatureAccessPolicyDialog() {
  const { t } = useTranslation()
  const { open, setOpen } = useSubscriptions()
  const { data } = useSystemOptions()
  const updateOption = useUpdateOption()
  const [policies, setPolicies] = useState<Record<string, string>>({})

  const isOpen = open === 'feature-access-policy'
  const options = getOptionValue(data?.data, {
    [ACCESS_POLICIES_OPTION_KEY]: '',
  })
  const savedRaw = options[ACCESS_POLICIES_OPTION_KEY]

  useEffect(() => {
    if (isOpen) {
      setPolicies(parsePolicies(savedRaw))
    }
  }, [isOpen, savedRaw])

  const handleToggle = (featureKey: string, isFree: boolean) => {
    setPolicies((prev) => {
      const next = { ...prev }
      if (isFree) {
        next[featureKey] = POLICY_FREE
      } else {
        delete next[featureKey]
      }
      return next
    })
  }

  const handleSave = async () => {
    const result = await updateOption.mutateAsync({
      key: ACCESS_POLICIES_OPTION_KEY,
      value: JSON.stringify(policies),
    })
    if (result.success) {
      setOpen(null)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && setOpen(null)}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>{t('Feature Access Policy')}</DialogTitle>
          <DialogDescription>
            {t(
              'Features marked free are available to all users; otherwise an active subscription containing the feature is required. Takes effect immediately without a client update.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-4 py-2'>
          {SUBSCRIPTION_FEATURE_ITEMS.map((item) => (
            <div
              key={item.key}
              className='flex items-center justify-between gap-4'
            >
              <div className='flex flex-col'>
                <span className='text-sm font-medium'>{t(item.labelKey)}</span>
                <span className='text-muted-foreground text-xs'>
                  {item.key}
                </span>
              </div>
              <div className='flex items-center gap-2'>
                <span className='text-muted-foreground text-xs'>
                  {policies[item.key] === POLICY_FREE
                    ? t('Free for all users')
                    : t('Subscription required')}
                </span>
                <Switch
                  checked={policies[item.key] === POLICY_FREE}
                  onCheckedChange={(checked) =>
                    handleToggle(item.key, checked === true)
                  }
                />
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={() => setOpen(null)}>
            {t('Cancel')}
          </Button>
          <Button onClick={handleSave} disabled={updateOption.isPending}>
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
