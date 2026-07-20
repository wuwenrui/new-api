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
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { SectionPageLayout } from '@/components/layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

import { getChannelPriceCompare } from './api'
import { PriceCompareTable } from './components/price-compare-table'

export function ChannelPriceCompare() {
  const { t } = useTranslation()
  const group = 'default'

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['channel-price-compare', group],
    queryFn: () => getChannelPriceCompare(group),
  })

  const probeErrors = Object.entries(data?.probe_errors ?? {})
  const models = data?.models ?? []
  const generatedAt = data?.generated_at
    ? new Date(data.generated_at * 1000).toLocaleString()
    : null

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        {t('Channel Price Compare')}
      </SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button
          variant='outline'
          size='sm'
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? <Spinner /> : <RefreshCw size={14} />}
          {t('Refresh')}
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        {isLoading ? (
          <div className='flex items-center justify-center py-16'>
            <Spinner className='size-6' />
          </div>
        ) : (
          <div className='space-y-4'>
            {(data?.local_group || generatedAt) && (
              <div className='text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs'>
                {data?.local_group && (
                  <span>
                    {t('Local pricing group')}: {data.local_group}
                  </span>
                )}
                {generatedAt && (
                  <span>
                    {t('Generated at')}: {generatedAt}
                  </span>
                )}
              </div>
            )}

            {probeErrors.length > 0 && (
              <Alert variant='destructive'>
                <AlertTriangle />
                <AlertTitle>{t('Upstream probe errors')}</AlertTitle>
                <AlertDescription>
                  <ul className='list-disc space-y-1 pl-4'>
                    {probeErrors.map(([base, message]) => (
                      <li key={base}>
                        <span className='font-mono break-all'>{base}</span>:{' '}
                        {message}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {models.length === 0 ? (
              <div className='text-muted-foreground py-16 text-center text-sm'>
                {t('No models to compare')}
              </div>
            ) : (
              models.map((model) => (
                <PriceCompareTable key={model.model_name} model={model} />
              ))
            )}
          </div>
        )}
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
