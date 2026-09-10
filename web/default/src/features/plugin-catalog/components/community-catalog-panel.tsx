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
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { searchCommunityCatalog } from '../api'
import type { PluginCatalogCommunityResult } from '../types'

type CommunityCatalogPanelProps = {
  onOpenEntry: (result: PluginCatalogCommunityResult) => void
}

export function CommunityCatalogPanel(props: CommunityCatalogPanelProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const resultsQuery = useQuery({
    queryKey: ['plugin-catalog-community', query],
    queryFn: () => searchCommunityCatalog(query),
    retry: false,
  })

  let content = null
  if (resultsQuery.isLoading) {
    content = <Skeleton className='h-32 w-full' />
  } else if (resultsQuery.isError) {
    content = (
      <p className='text-destructive text-sm'>{resultsQuery.error.message}</p>
    )
  } else if ((resultsQuery.data ?? []).length === 0) {
    content = (
      <p className='text-muted-foreground text-sm'>
        {t('No community plugin matches this search.')}
      </p>
    )
  } else {
    content = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('Plugin')}</TableHead>
            <TableHead>{t('npm package')}</TableHead>
            <TableHead>{t('Version')}</TableHead>
            <TableHead>{t('Category')}</TableHead>
            <TableHead>{t('Status')}</TableHead>
            <TableHead className='text-right'>{t('Actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(resultsQuery.data ?? []).map((result) => (
            <TableRow key={result.repo}>
              <TableCell>
                <div className='font-medium'>{result.name}</div>
                {result.description ? (
                  <div className='text-muted-foreground max-w-96 text-xs'>
                    {result.description}
                  </div>
                ) : null}
              </TableCell>
              <TableCell className='font-mono text-xs'>
                {result.packageName || '-'}
              </TableCell>
              <TableCell>{result.version}</TableCell>
              <TableCell>{result.category}</TableCell>
              <TableCell>
                {result.alreadyOpen ? (
                  <Badge variant='secondary'>
                    {result.openEnabled
                      ? t('Opened · enabled')
                      : t('Opened · disabled')}
                  </Badge>
                ) : (
                  <Badge variant='outline'>{t('Not opened')}</Badge>
                )}
              </TableCell>
              <TableCell className='text-right'>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => props.onOpenEntry(result)}
                >
                  {result.alreadyOpen ? t('Update') : t('Open')}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
  }

  return (
    <div className='space-y-4'>
      <form
        className='flex items-center gap-2'
        onSubmit={(event) => {
          event.preventDefault()
          setQuery(draft.trim())
        }}
      >
        <Input
          value={draft}
          placeholder={t('Search the community catalog')}
          aria-label={t('Search the community catalog')}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type='submit' variant='secondary'>
          <Search className='size-4' />
          {t('Search')}
        </Button>
      </form>
      {content}
    </div>
  )
}
