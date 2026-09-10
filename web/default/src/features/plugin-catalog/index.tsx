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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { SectionPageLayout } from '@/components/layout'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import {
  deleteCommunityEntry,
  deleteOwnedEntry,
  downloadCommunityRegistry,
  downloadOwnedRegistry,
  getPluginCatalog,
  requestPublish,
  upsertCommunityEntry,
  upsertOwnedEntry,
} from './api'
import { CommunityCatalogPanel } from './components/community-catalog-panel'
import { CommunityEntryDialog } from './components/community-entry-dialog'
import { OpenEntriesPanel } from './components/open-entries-panel'
import { OwnedEntryDialog } from './components/owned-entry-dialog'
import { PublishPanel } from './components/publish-panel'
import { entryFromSearchResult } from './lib/entries'
import type {
  PluginCatalogCommunityEntry,
  PluginCatalogCommunityResult,
  PluginCatalogOwnedEntry,
} from './types'

export function PluginCatalog() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [dialogEntry, setDialogEntry] =
    useState<PluginCatalogCommunityEntry | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] =
    useState<PluginCatalogCommunityEntry | null>(null)
  const [ownedDialogEntry, setOwnedDialogEntry] =
    useState<PluginCatalogOwnedEntry | null>(null)
  const [ownedDialogOpen, setOwnedDialogOpen] = useState(false)
  const [ownedDeleteTarget, setOwnedDeleteTarget] =
    useState<PluginCatalogOwnedEntry | null>(null)
  const catalogQuery = useQuery({
    queryKey: ['plugin-catalog'],
    queryFn: getPluginCatalog,
  })
  const ownedUpsertMutation = useMutation({
    mutationFn: upsertOwnedEntry,
    onSuccess: (document) => {
      queryClient.setQueryData(['plugin-catalog'], document)
      toast.success(t('First-party plugin saved'))
      setOwnedDialogOpen(false)
    },
    onError: (error) => toast.error(error.message),
  })
  const ownedDeleteMutation = useMutation({
    mutationFn: deleteOwnedEntry,
    onSuccess: (document) => {
      queryClient.setQueryData(['plugin-catalog'], document)
      toast.success(t('First-party plugin removed'))
      setOwnedDeleteTarget(null)
    },
    onError: (error) => toast.error(error.message),
  })
  const upsertMutation = useMutation({
    mutationFn: upsertCommunityEntry,
    onSuccess: (document) => {
      queryClient.setQueryData(['plugin-catalog'], document)
      queryClient.invalidateQueries({ queryKey: ['plugin-catalog-community'] })
      toast.success(t('Community plugin saved'))
      setDialogOpen(false)
    },
    onError: (error) => toast.error(error.message),
  })
  const deleteMutation = useMutation({
    mutationFn: deleteCommunityEntry,
    onSuccess: (document) => {
      queryClient.setQueryData(['plugin-catalog'], document)
      queryClient.invalidateQueries({ queryKey: ['plugin-catalog-community'] })
      toast.success(t('Community plugin removed'))
      setDeleteTarget(null)
    },
    onError: (error) => toast.error(error.message),
  })
  const publishMutation = useMutation({
    mutationFn: requestPublish,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plugin-catalog'] })
      toast.success(t('Release request recorded'))
    },
    onError: (error) => toast.error(error.message),
  })
  const openEntry = (entry: PluginCatalogCommunityEntry) => {
    setDialogEntry(entry)
    setDialogOpen(true)
  }
  const openManualEntry = () => {
    setDialogEntry(null)
    setDialogOpen(true)
  }
  const openFromSearch = (result: PluginCatalogCommunityResult) => {
    openEntry(entryFromSearchResult(result))
  }
  const openOwnedDialog = (entry: PluginCatalogOwnedEntry | null) => {
    setOwnedDialogEntry(entry)
    setOwnedDialogOpen(true)
  }
  const downloadFailed = (error: Error) => toast.error(error.message)
  const document = catalogQuery.data

  return (
    <>
      <SectionPageLayout fixedContent>
        <SectionPageLayout.Title>{t('Plugin Catalog')}</SectionPageLayout.Title>
        <SectionPageLayout.Content>
          {catalogQuery.isLoading ? <Skeleton className='h-64 w-full' /> : null}
          {catalogQuery.isError ? (
            <p className='text-destructive text-sm'>
              {catalogQuery.error.message}
            </p>
          ) : null}
          {document ? (
            <Tabs defaultValue='open'>
              <TabsList>
                <TabsTrigger value='open'>{t('Open list')}</TabsTrigger>
                <TabsTrigger value='community'>
                  {t('Community catalog')}
                </TabsTrigger>
                <TabsTrigger value='publish'>{t('Release')}</TabsTrigger>
              </TabsList>
              <TabsContent value='open' className='pt-4'>
                <OpenEntriesPanel
                  document={document}
                  pending={
                    upsertMutation.isPending ||
                    deleteMutation.isPending ||
                    ownedUpsertMutation.isPending ||
                    ownedDeleteMutation.isPending
                  }
                  onAddOwned={() => openOwnedDialog(null)}
                  onEditOwned={openOwnedDialog}
                  onToggleOwned={(entry, enabled) =>
                    ownedUpsertMutation.mutate({ ...entry, enabled })
                  }
                  onDeleteOwned={setOwnedDeleteTarget}
                  onOpenManual={openManualEntry}
                  onEdit={openEntry}
                  onToggle={(entry, enabled) =>
                    upsertMutation.mutate({ ...entry, enabled })
                  }
                  onDelete={setDeleteTarget}
                />
              </TabsContent>
              <TabsContent value='community' className='pt-4'>
                <CommunityCatalogPanel onOpenEntry={openFromSearch} />
              </TabsContent>
              <TabsContent value='publish' className='pt-4'>
                <PublishPanel
                  document={document}
                  pending={publishMutation.isPending}
                  onPublish={(note) => publishMutation.mutate(note)}
                  onDownloadOwned={() => {
                    downloadOwnedRegistry().catch(downloadFailed)
                  }}
                  onDownloadCommunity={() => {
                    downloadCommunityRegistry().catch(downloadFailed)
                  }}
                />
              </TabsContent>
            </Tabs>
          ) : null}
        </SectionPageLayout.Content>
      </SectionPageLayout>

      <CommunityEntryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entry={dialogEntry}
        pending={upsertMutation.isPending}
        onSubmit={(entry) => upsertMutation.mutate(entry)}
      />
      <OwnedEntryDialog
        open={ownedDialogOpen}
        onOpenChange={setOwnedDialogOpen}
        entry={ownedDialogEntry}
        pending={ownedUpsertMutation.isPending}
        onSubmit={(entry) => ownedUpsertMutation.mutate(entry)}
      />
      <ConfirmDialog
        open={ownedDeleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setOwnedDeleteTarget(null)
        }}
        title={t('Remove this first-party plugin?')}
        desc={t(
          'It disappears from this list and the next release stops packing it. Users who already installed it keep it until they uninstall.'
        )}
        destructive
        isLoading={ownedDeleteMutation.isPending}
        handleConfirm={() => {
          if (!ownedDeleteTarget) return
          ownedDeleteMutation.mutate(ownedDeleteTarget.id)
        }}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={t('Remove this community plugin?')}
        desc={t(
          'Users will no longer see it in the plugin market after the next release.'
        )}
        destructive
        isLoading={deleteMutation.isPending}
        handleConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id)
        }}
      />
    </>
  )
}
