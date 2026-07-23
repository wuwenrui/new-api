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
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import {
  type WizardStep,
  useNewAPIOnboard,
  type OnboardSource,
} from '../../hooks/use-newapi-onboard'
import { NewAPIOnboardFinalizeStep } from './newapi-onboard-finalize-step'
import { NewAPIOnboardSelectStep } from './newapi-onboard-select-step'

const STEP_DESCRIPTIONS: Record<WizardStep, string> = {
  connect:
    'Enter the upstream site address to discover its groups, models and pricing',
  select:
    'All groups at a glance: filter groups, tick models and set local prices',
  finalize: 'Set channel info and confirm pricing',
}

const SUB2API_STEP_DESCRIPTIONS: Record<WizardStep, string> = {
  connect: 'Choose a provider and apply the upstream price multiplier',
  select:
    'Review model costs, adjust sale prices, and choose models for this channel',
  finalize: 'Set the relay API key, local groups, and model pricing',
}

type NewAPIOnboardDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  source?: OnboardSource
}

export function NewAPIOnboardDialog({
  open,
  onOpenChange,
  source = 'newapi',
}: NewAPIOnboardDialogProps) {
  const { t } = useTranslation()
  const ctl = useNewAPIOnboard(open, onOpenChange, source)

  const renderConnectStep = () => (
    <div className='space-y-4'>
      <div className='space-y-2'>
        <Label htmlFor='newapi-base-url'>{t('Upstream site address')}</Label>
        <Input
          id='newapi-base-url'
          placeholder='https://api.example.com'
          value={ctl.baseUrl}
          onChange={(e) => ctl.setBaseUrl(e.target.value)}
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
          value={ctl.accessToken}
          onChange={(e) => ctl.setAccessToken(e.target.value)}
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
          value={ctl.userId}
          onChange={(e) => ctl.setUserId(e.target.value)}
        />
      </div>
    </div>
  )

  const renderSub2APIConnectStep = () => (
    <div className='space-y-5'>
      <div className='space-y-2'>
        <Label htmlFor='sub2api-base-url'>{t('Upstream site address')}</Label>
        <Input
          id='sub2api-base-url'
          placeholder='https://api.example.com'
          value={ctl.baseUrl}
          onChange={(event) => ctl.setBaseUrl(event.target.value)}
        />
        <p className='text-muted-foreground text-xs'>
          {t('Enter the Sub2API site address used to relay model requests.')}
        </p>
      </div>
      <div className='grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]'>
        <div className='space-y-2'>
          <Label htmlFor='sub2api-provider'>{t('Model provider')}</Label>
          <Combobox
            id='sub2api-provider'
            options={ctl.providerOptions.map((provider) => ({
              value: provider.id,
              label: `${provider.name} (${provider.modelCount})`,
            }))}
            value={ctl.providerId}
            onValueChange={(value) => ctl.setProviderId(value ?? '')}
            placeholder={
              ctl.modelsDevLoading
                ? t('Loading model catalog...')
                : t('Search and select a provider')
            }
            emptyText={t('No token-priced provider found')}
          />
        </div>
        <div className='space-y-2'>
          <Label htmlFor='sub2api-multiplier'>{t('Upstream multiplier')}</Label>
          <Input
            id='sub2api-multiplier'
            type='number'
            min='0.000001'
            step='0.01'
            value={ctl.upstreamMultiplierInput}
            onChange={(event) =>
              ctl.setUpstreamMultiplierInput(event.target.value)
            }
          />
        </div>
      </div>
      <p
        className={
          ctl.modelsDevError
            ? 'text-destructive text-xs'
            : 'text-muted-foreground text-xs'
        }
      >
        {ctl.modelsDevError ||
          t(
            'Provider models and official token prices are loaded from the latest models.dev catalog.'
          )}
      </p>
    </div>
  )

  const footer = (
    <>
      <Button
        variant='outline'
        onClick={ctl.handleClose}
        disabled={ctl.isSubmitting}
      >
        {t('Cancel')}
      </Button>
      {ctl.step !== 'connect' && (
        <Button
          variant='outline'
          disabled={ctl.isSubmitting}
          onClick={() =>
            ctl.setStep(ctl.step === 'finalize' ? 'select' : 'connect')
          }
        >
          {t('Back')}
        </Button>
      )}
      {ctl.step === 'connect' && source === 'newapi' && (
        <Button onClick={ctl.handleProbe} disabled={ctl.isProbing}>
          {ctl.isProbing && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
          {ctl.isProbing ? t('Probing...') : t('Probe upstream')}
        </Button>
      )}
      {ctl.step === 'connect' && source === 'sub2api' && (
        <Button
          onClick={ctl.handleSub2APIConnect}
          disabled={ctl.modelsDevLoading || !ctl.providerId}
        >
          {ctl.modelsDevLoading && (
            <Loader2 className='mr-2 h-4 w-4 animate-spin' />
          )}
          {ctl.modelsDevLoading ? t('Loading...') : t('Load provider models')}
        </Button>
      )}
      {ctl.step === 'select' && (
        <Button
          onClick={ctl.enterFinalize}
          disabled={ctl.selectedModels.size === 0}
        >
          {t('Next: channel info')}
        </Button>
      )}
      {ctl.step === 'finalize' && (
        <Button onClick={ctl.handleSubmit} disabled={ctl.isSubmitting}>
          {ctl.isSubmitting && (
            <Loader2 className='mr-2 h-4 w-4 animate-spin' />
          )}
          {ctl.isSubmitting ? t('Creating...') : t('Create Channel')}
        </Button>
      )}
    </>
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && ctl.handleClose()}
      title={t(
        source === 'sub2api'
          ? 'Onboard Sub2API upstream'
          : 'Onboard NewAPI upstream'
      )}
      description={t(
        source === 'sub2api'
          ? SUB2API_STEP_DESCRIPTIONS[ctl.step]
          : STEP_DESCRIPTIONS[ctl.step]
      )}
      contentClassName={
        ctl.maximized ? 'max-w-[97vw] sm:max-w-[97vw]' : 'max-w-5xl'
      }
      contentHeight='auto'
      bodyClassName='space-y-4'
      footer={footer}
    >
      {ctl.step === 'connect' &&
        (source === 'sub2api'
          ? renderSub2APIConnectStep()
          : renderConnectStep())}
      {ctl.step === 'select' && <NewAPIOnboardSelectStep ctl={ctl} />}
      {ctl.step === 'finalize' && <NewAPIOnboardFinalizeStep ctl={ctl} />}
    </Dialog>
  )
}

export function Sub2APIOnboardDialog(
  props: Omit<NewAPIOnboardDialogProps, 'source'>
) {
  return <NewAPIOnboardDialog {...props} source='sub2api' />
}
