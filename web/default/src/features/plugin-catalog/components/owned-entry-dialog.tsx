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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

import type { PluginCatalogOwnedEntry } from '../types'

type OwnedEntryDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  entry: PluginCatalogOwnedEntry | null
  pending: boolean
  onSubmit: (entry: PluginCatalogOwnedEntry) => void
}

function emptyEntry(): PluginCatalogOwnedEntry {
  return {
    id: '',
    directory: '',
    name: '',
    description: '',
    category: '业务',
    enabled: true,
  }
}

export function OwnedEntryDialog(props: OwnedEntryDialogProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<PluginCatalogOwnedEntry>(emptyEntry)
  const invalid =
    !draft.id.trim() ||
    !draft.directory.trim() ||
    !draft.name.trim() ||
    !draft.description.trim()

  // The dialog edits a local copy so a half-typed entry never reaches the
  // server; it re-seeds from the caller every time it opens.
  useEffect(() => {
    if (!props.open) return
    setDraft(props.entry ?? emptyEntry())
  }, [props.open, props.entry])

  const update = (patch: Partial<PluginCatalogOwnedEntry>) => {
    setDraft((current) => ({ ...current, ...patch }))
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className='max-w-2xl'>
        <DialogHeader>
          <DialogTitle>{t('First-party plugin')}</DialogTitle>
          <DialogDescription>
            {t(
              'The release pipeline packs the directory below and reads the version from its package manifest. This page decides what the next release includes.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-4 sm:grid-cols-2'>
          <div className='space-y-2'>
            <Label htmlFor='owned-catalog-id'>{t('Plugin ID')}</Label>
            <Input
              id='owned-catalog-id'
              value={draft.id}
              placeholder='lawyer-contract'
              onChange={(event) => update({ id: event.target.value })}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='owned-catalog-directory'>
              {t('Plugin directory')}
            </Label>
            <Input
              id='owned-catalog-directory'
              value={draft.directory}
              placeholder='packages/lawyer-contract'
              onChange={(event) => update({ directory: event.target.value })}
            />
            <p className='text-muted-foreground text-xs'>
              {t(
                'Repository-relative path, for example packages/lawyer-filing.'
              )}
            </p>
          </div>
          <div className='space-y-2'>
            <Label htmlFor='owned-catalog-name'>{t('Name')}</Label>
            <Input
              id='owned-catalog-name'
              value={draft.name}
              placeholder={t('Contract review')}
              onChange={(event) => update({ name: event.target.value })}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='owned-catalog-category'>{t('Category')}</Label>
            <Input
              id='owned-catalog-category'
              value={draft.category}
              onChange={(event) => update({ category: event.target.value })}
            />
          </div>
          <div className='space-y-2 sm:col-span-2'>
            <Label htmlFor='owned-catalog-description'>
              {t('Description')}
            </Label>
            <Textarea
              id='owned-catalog-description'
              rows={3}
              value={draft.description}
              placeholder={t('What this capability does for the lawyer.')}
              onChange={(event) => update({ description: event.target.value })}
            />
          </div>
          <div className='flex items-center gap-3'>
            <Switch
              id='owned-catalog-enabled'
              checked={draft.enabled}
              onCheckedChange={(checked) => update({ enabled: checked })}
            />
            <Label htmlFor='owned-catalog-enabled' className='font-normal'>
              {t('Include in the next release')}
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant='outline'
            onClick={() => props.onOpenChange(false)}
            disabled={props.pending}
          >
            {t('Cancel')}
          </Button>
          <Button
            onClick={() => props.onSubmit(draft)}
            disabled={invalid || props.pending}
          >
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
