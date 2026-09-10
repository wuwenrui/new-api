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

import type { PluginCatalogCommunityEntry } from '../types'

type CommunityEntryDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  entry: PluginCatalogCommunityEntry | null
  pending: boolean
  onSubmit: (entry: PluginCatalogCommunityEntry) => void
}

function emptyEntry(): PluginCatalogCommunityEntry {
  return {
    id: '',
    owner: '',
    repo: '',
    packageName: '',
    version: '',
    category: '社区',
    enabled: true,
  }
}

export function CommunityEntryDialog(props: CommunityEntryDialogProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<PluginCatalogCommunityEntry>(emptyEntry)
  const invalid =
    !draft.id.trim() ||
    !draft.owner.trim() ||
    !draft.repo.trim() ||
    !draft.packageName.trim() ||
    !draft.version.trim()

  // The dialog edits a local copy so a half-typed entry never reaches the
  // server; it re-seeds from the caller every time it opens.
  useEffect(() => {
    if (!props.open) return
    setDraft(props.entry ?? emptyEntry())
  }, [props.open, props.entry])

  const update = (patch: Partial<PluginCatalogCommunityEntry>) => {
    setDraft((current) => ({ ...current, ...patch }))
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className='max-w-2xl'>
        <DialogHeader>
          <DialogTitle>{t('Open a community plugin')}</DialogTitle>
          <DialogDescription>
            {t(
              'The gateway stores the entry and hands it to the release publisher. Publishing and signing happen on the release machine, never in the browser.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-4 sm:grid-cols-2'>
          <div className='space-y-2'>
            <Label htmlFor='plugin-catalog-id'>{t('Plugin ID')}</Label>
            <Input
              id='plugin-catalog-id'
              value={draft.id}
              placeholder='lawyer-doc-review'
              onChange={(event) => update({ id: event.target.value })}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='plugin-catalog-owner'>
              {t('Repository owner')}
            </Label>
            <Input
              id='plugin-catalog-owner'
              value={draft.owner}
              placeholder='wuwenrui'
              onChange={(event) => update({ owner: event.target.value })}
            />
          </div>
          <div className='space-y-2 sm:col-span-2'>
            <Label htmlFor='plugin-catalog-repo'>{t('Repository URL')}</Label>
            <Input
              id='plugin-catalog-repo'
              value={draft.repo}
              placeholder='https://github.com/wuwenrui/dsh-plugin-doc-review'
              onChange={(event) => update({ repo: event.target.value })}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='plugin-catalog-package'>{t('npm package')}</Label>
            <Input
              id='plugin-catalog-package'
              value={draft.packageName}
              placeholder='dsh-plugin-doc-review'
              onChange={(event) => update({ packageName: event.target.value })}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='plugin-catalog-version'>{t('Exact version')}</Label>
            <Input
              id='plugin-catalog-version'
              value={draft.version}
              placeholder='1.2.0'
              onChange={(event) => update({ version: event.target.value })}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='plugin-catalog-category'>{t('Category')}</Label>
            <Input
              id='plugin-catalog-category'
              value={draft.category}
              onChange={(event) => update({ category: event.target.value })}
            />
          </div>
          <div className='flex items-center gap-3 pt-6'>
            <Switch
              id='plugin-catalog-enabled'
              checked={draft.enabled}
              onCheckedChange={(checked) => update({ enabled: checked })}
            />
            <Label htmlFor='plugin-catalog-enabled' className='font-normal'>
              {t('Available to users')}
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
