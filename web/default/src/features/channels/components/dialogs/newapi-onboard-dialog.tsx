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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog } from '@/components/dialog'
import {
  type WizardStep,
  useNewAPIOnboard,
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

type NewAPIOnboardDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function NewAPIOnboardDialog({
  open,
  onOpenChange,
}: NewAPIOnboardDialogProps) {
  const { t } = useTranslation()
  const ctl = useNewAPIOnboard(open, onOpenChange)

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
      {ctl.step === 'connect' && (
        <Button onClick={ctl.handleProbe} disabled={ctl.isProbing}>
          {ctl.isProbing && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
          {ctl.isProbing ? t('Probing...') : t('Probe upstream')}
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
      title={t('Onboard NewAPI upstream')}
      description={t(STEP_DESCRIPTIONS[ctl.step])}
      contentClassName={
        ctl.maximized ? 'max-w-[97vw] sm:max-w-[97vw]' : 'max-w-5xl'
      }
      contentHeight='auto'
      bodyClassName='space-y-4'
      footer={footer}
    >
      {ctl.step === 'connect' && renderConnectStep()}
      {ctl.step === 'select' && <NewAPIOnboardSelectStep ctl={ctl} />}
      {ctl.step === 'finalize' && <NewAPIOnboardFinalizeStep ctl={ctl} />}
    </Dialog>
  )
}
