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
import { Download, Send } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { formatTimestampToDate } from '@/lib/format'

import type { PluginCatalogDocument } from '../types'

type PublishPanelProps = {
  document: PluginCatalogDocument
  pending: boolean
  onPublish: (note: string) => void
  onDownloadOwned: () => void
  onDownloadCommunity: () => void
}

const STATUS_VARIANT: Record<string, 'secondary' | 'destructive' | 'outline'> =
  {
    dispatched: 'secondary',
    pending: 'outline',
    failed: 'destructive',
  }

export function PublishPanel(props: PublishPanelProps) {
  const { t } = useTranslation()
  const [note, setNote] = useState('')
  const requests = props.document.publishRequests

  return (
    <div className='space-y-6'>
      <section className='space-y-2'>
        <h3 className='text-sm font-medium'>{t('Current registry')}</h3>
        <dl className='text-sm'>
          <div className='flex gap-2'>
            <dt className='text-muted-foreground w-32'>
              {t('Registry revision')}
            </dt>
            <dd className='font-mono'>{props.document.revision}</dd>
          </div>
          <div className='flex gap-2'>
            <dt className='text-muted-foreground w-32'>
              {t('Last changed by')}
            </dt>
            <dd>{props.document.updatedBy || '-'}</dd>
          </div>
          <div className='flex gap-2'>
            <dt className='text-muted-foreground w-32'>
              {t('Last changed at')}
            </dt>
            <dd>
              {props.document.updatedAt
                ? formatTimestampToDate(props.document.updatedAt)
                : '-'}
            </dd>
          </div>
        </dl>
        <div className='flex flex-wrap gap-2'>
          <Button variant='outline' size='sm' onClick={props.onDownloadOwned}>
            <Download className='size-4' />
            {t('Download first-party list')}
          </Button>
          <Button
            variant='outline'
            size='sm'
            onClick={props.onDownloadCommunity}
          >
            <Download className='size-4' />
            {t('Download community list')}
          </Button>
        </div>
        <p className='text-muted-foreground text-sm'>
          {t(
            'The release machine packs from approved.json and resolves community-approved.json into the same signed catalog.'
          )}
        </p>
      </section>

      <section className='space-y-3'>
        <div>
          <h3 className='text-sm font-medium'>{t('Request a release')}</h3>
          <p className='text-muted-foreground text-sm'>
            {t(
              'This only records the request and dispatches the configured webhook. Signing and publishing still run on the release machine.'
            )}
          </p>
        </div>
        <div className='space-y-2'>
          <Label htmlFor='plugin-catalog-publish-note'>
            {t('Release note')}
          </Label>
          <Textarea
            id='plugin-catalog-publish-note'
            rows={2}
            value={note}
            placeholder={t('What changed in this release?')}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <Button
          size='sm'
          disabled={props.pending}
          onClick={() => props.onPublish(note.trim())}
        >
          <Send className='size-4' />
          {t('Request release')}
        </Button>
      </section>

      <section className='space-y-3'>
        <h3 className='text-sm font-medium'>{t('Release history')}</h3>
        {requests.length === 0 ? (
          <p className='text-muted-foreground text-sm'>
            {t('No release has been requested yet.')}
          </p>
        ) : (
          <Table className='table-fixed'>
            <TableHeader>
              <TableRow>
                <TableHead className='w-[14%]'>{t('Requested at')}</TableHead>
                <TableHead className='w-[10%]'>{t('Requested by')}</TableHead>
                <TableHead className='w-[12%]'>
                  {t('Registry revision')}
                </TableHead>
                <TableHead className='w-[44%]'>{t('Release note')}</TableHead>
                <TableHead className='w-[20%]'>{t('Status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((request) => (
                <TableRow key={request.id}>
                  <TableCell className='truncate'>
                    {formatTimestampToDate(request.requestedAt)}
                  </TableCell>
                  <TableCell className='truncate'>
                    {request.requestedBy}
                  </TableCell>
                  <TableCell className='truncate font-mono'>
                    {request.revision}
                  </TableCell>
                  <TableCell>
                    <div className='flex min-w-0 flex-col gap-0.5'>
                      <span className='truncate' title={request.note}>
                        {request.note || '-'}
                      </span>
                      {request.detail ? (
                        <span
                          className='text-muted-foreground line-clamp-2 text-xs whitespace-normal'
                          title={request.detail}
                        >
                          {request.detail}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className='truncate'>
                    <Badge
                      variant={STATUS_VARIANT[request.status] ?? 'outline'}
                    >
                      {request.status}
                    </Badge>
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
