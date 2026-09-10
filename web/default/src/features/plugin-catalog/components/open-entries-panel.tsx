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
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import type {
  PluginCatalogCommunityEntry,
  PluginCatalogDocument,
  PluginCatalogOwnedEntry,
} from '../types'

type OpenEntriesPanelProps = {
  document: PluginCatalogDocument
  pending: boolean
  onAddOwned: () => void
  onEditOwned: (entry: PluginCatalogOwnedEntry) => void
  onToggleOwned: (entry: PluginCatalogOwnedEntry, enabled: boolean) => void
  onDeleteOwned: (entry: PluginCatalogOwnedEntry) => void
  onOpenManual: () => void
  onEdit: (entry: PluginCatalogCommunityEntry) => void
  onToggle: (entry: PluginCatalogCommunityEntry, enabled: boolean) => void
  onDelete: (entry: PluginCatalogCommunityEntry) => void
}

export function OpenEntriesPanel(props: OpenEntriesPanelProps) {
  const { t } = useTranslation()
  const owned = props.document.owned
  const community = props.document.community

  return (
    <div className='space-y-6'>
      <section className='space-y-3'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div>
            <h3 className='text-sm font-medium'>{t('First-party plugins')}</h3>
            <p className='text-muted-foreground text-sm'>
              {t(
                'Written by us. The release pipeline packs the entries switched on here and reads each version from its package manifest.'
              )}
            </p>
          </div>
          <Button size='sm' onClick={props.onAddOwned}>
            <Plus className='size-4' />
            {t('Add a first-party plugin')}
          </Button>
        </div>
        {owned.length === 0 ? (
          <p className='text-muted-foreground text-sm'>
            {t('No first-party plugins registered yet.')}
          </p>
        ) : (
          <Table className='table-fixed'>
            <TableHeader>
              <TableRow>
                <TableHead className='w-[30%]'>{t('Plugin')}</TableHead>
                <TableHead className='w-[14%]'>{t('Plugin ID')}</TableHead>
                <TableHead className='w-[20%]'>
                  {t('Plugin directory')}
                </TableHead>
                <TableHead className='w-[8%]'>{t('Category')}</TableHead>
                <TableHead className='w-[16%]'>
                  {t('Include in the next release')}
                </TableHead>
                <TableHead className='w-[12%] text-right'>
                  {t('Actions')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {owned.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    <div className='flex min-w-0 flex-col gap-0.5'>
                      <span className='truncate font-medium' title={entry.name}>
                        {entry.name}
                      </span>
                      <span
                        className='text-muted-foreground line-clamp-2 text-xs whitespace-normal'
                        title={entry.description}
                      >
                        {entry.description}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className='truncate font-mono text-xs'>
                    {entry.id}
                  </TableCell>
                  <TableCell
                    className='truncate font-mono text-xs'
                    title={entry.directory}
                  >
                    {entry.directory}
                  </TableCell>
                  <TableCell className='truncate'>{entry.category}</TableCell>
                  <TableCell>
                    <Switch
                      aria-label={`${t('Include in the next release')} ${entry.name}`}
                      checked={entry.enabled}
                      disabled={props.pending}
                      onCheckedChange={(checked) =>
                        props.onToggleOwned(entry, checked)
                      }
                    />
                  </TableCell>
                  <TableCell className='text-right'>
                    <div className='flex justify-end gap-1'>
                      <Button
                        variant='ghost'
                        size='icon-sm'
                        aria-label={`${t('Edit')} ${entry.name}`}
                        onClick={() => props.onEditOwned(entry)}
                      >
                        <Pencil className='size-4' />
                      </Button>
                      <Button
                        variant='ghost'
                        size='icon-sm'
                        aria-label={`${t('Remove')} ${entry.name}`}
                        disabled={props.pending}
                        onClick={() => props.onDeleteOwned(entry)}
                      >
                        <Trash2 className='size-4' />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className='space-y-3'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div>
            <h3 className='text-sm font-medium'>
              {t('Open community plugins')}
            </h3>
            <p className='text-muted-foreground text-sm'>
              {t(
                'Users can only install community plugins listed here and enabled.'
              )}
            </p>
          </div>
          <Button size='sm' onClick={props.onOpenManual}>
            <Plus className='size-4' />
            {t('Open manually')}
          </Button>
        </div>
        {community.length === 0 ? (
          <p className='text-muted-foreground text-sm'>
            {t('No community plugin is open yet.')}
          </p>
        ) : (
          <Table className='table-fixed'>
            <TableHeader>
              <TableRow>
                <TableHead className='w-[16%]'>{t('Plugin ID')}</TableHead>
                <TableHead className='w-[26%]'>{t('npm package')}</TableHead>
                <TableHead className='w-[10%]'>{t('Version')}</TableHead>
                <TableHead className='w-[10%]'>{t('Category')}</TableHead>
                <TableHead className='w-[22%]'>
                  {t('Available to users')}
                </TableHead>
                <TableHead className='w-[16%] text-right'>
                  {t('Actions')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {community.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className='truncate font-mono text-xs'>
                    {entry.id}
                  </TableCell>
                  <TableCell
                    className='truncate font-mono text-xs'
                    title={entry.packageName}
                  >
                    {entry.packageName}
                  </TableCell>
                  <TableCell className='truncate'>{entry.version}</TableCell>
                  <TableCell className='truncate'>
                    <Badge variant='outline'>{entry.category}</Badge>
                  </TableCell>
                  <TableCell>
                    <Switch
                      aria-label={`${t('Available to users')} ${entry.id}`}
                      checked={entry.enabled}
                      disabled={props.pending}
                      onCheckedChange={(checked) =>
                        props.onToggle(entry, checked)
                      }
                    />
                  </TableCell>
                  <TableCell className='text-right'>
                    <div className='flex justify-end gap-1'>
                      <Button
                        variant='ghost'
                        size='icon-sm'
                        aria-label={`${t('Edit')} ${entry.id}`}
                        onClick={() => props.onEdit(entry)}
                      >
                        <Pencil className='size-4' />
                      </Button>
                      <Button
                        variant='ghost'
                        size='icon-sm'
                        aria-label={`${t('Remove')} ${entry.id}`}
                        disabled={props.pending}
                        onClick={() => props.onDelete(entry)}
                      >
                        <Trash2 className='size-4' />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  )
}
