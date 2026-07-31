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
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Pencil, Plus, TestTube, Trash2 } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  sideDrawerContentClassName,
  sideDrawerFormClassName,
  sideDrawerHeaderClassName,
} from '@/components/drawer-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  getSystemOptions,
  updateSystemOption,
} from '@/features/system-settings/api'

import { getChannels, probeNewAPIUpstream } from '../../api'
import {
  UPSTREAM_PROBE_CONFIGS_OPTION_KEY,
  findUpstreamProbeConfig,
  normalizeUpstreamBaseUrl,
  parseUpstreamProbeConfigs,
  removeUpstreamProbeConfig,
  upsertUpstreamProbeConfig,
  type UpstreamProbeConfig,
} from '../../lib'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type TestState = { loading?: boolean; ok?: boolean; text?: string }

export function UpstreamSitesDrawer({ open, onOpenChange }: Props) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: systemOptionsResp } = useQuery({
    queryKey: ['system-options'],
    queryFn: getSystemOptions,
    enabled: open,
  })
  // 拉全量渠道只为统计每个站点的关联渠道数与未填上游分组的渠道数
  const { data: channelsResp } = useQuery({
    queryKey: ['channels', 'upstream-sites-all'],
    queryFn: () => getChannels({ page_size: 500 }),
    enabled: open,
  })

  const rawConfigs = useMemo(
    () =>
      (systemOptionsResp?.data ?? []).find(
        (o: { key: string; value: string }) =>
          o.key === UPSTREAM_PROBE_CONFIGS_OPTION_KEY
      )?.value ?? '',
    [systemOptionsResp]
  )
  const sites = useMemo(() => parseUpstreamProbeConfigs(rawConfigs), [rawConfigs])
  const channels = useMemo(
    () => channelsResp?.data?.items ?? [],
    [channelsResp]
  )

  const [formOpen, setFormOpen] = useState(false)
  // editingBase 为 null 表示新增；编辑时 base_url 不可改（改地址 = 删旧加新）
  const [editingBase, setEditingBase] = useState<string | null>(null)
  const [formBaseUrl, setFormBaseUrl] = useState('')
  const [formUserId, setFormUserId] = useState('')
  const [formToken, setFormToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [deletingSite, setDeletingSite] = useState<UpstreamProbeConfig | null>(
    null
  )
  const [deleting, setDeleting] = useState(false)
  const [tests, setTests] = useState<Record<string, TestState>>({})

  const channelStatsFor = (base: string) => {
    const related = channels.filter(
      (c) => normalizeUpstreamBaseUrl(c.base_url || '') === base
    )
    const missingGroup = related.filter((c) => {
      try {
        const settings = JSON.parse(c.settings || '{}')
        return !settings.pac_upstream_group
      } catch {
        return true
      }
    })
    return { related: related.length, missingGroup: missingGroup.length }
  }

  const openAddForm = () => {
    setEditingBase(null)
    setFormBaseUrl('')
    setFormUserId('')
    setFormToken('')
    setFormOpen(true)
  }

  const openEditForm = (site: UpstreamProbeConfig) => {
    setEditingBase(normalizeUpstreamBaseUrl(site.base_url))
    setFormBaseUrl(site.base_url)
    setFormUserId(site.user_id)
    setFormToken('') // 令牌永不回显，留空 = 保留原值
    setFormOpen(true)
  }

  const handleSave = async () => {
    const base = normalizeUpstreamBaseUrl(formBaseUrl)
    if (!base) {
      toast.error(t('Base URL is required'))
      return
    }
    const existing = findUpstreamProbeConfig(rawConfigs, base)
    const token = formToken.trim() || existing?.access_token || ''
    if (!token) {
      toast.error(t('Probe token is required when adding a site'))
      return
    }
    setSaving(true)
    try {
      const resp = await updateSystemOption({
        key: UPSTREAM_PROBE_CONFIGS_OPTION_KEY,
        value: upsertUpstreamProbeConfig(rawConfigs, {
          base_url: base,
          access_token: token,
          user_id: formUserId.trim(),
        }),
      })
      if (!resp.success) {
        throw new Error(resp.message)
      }
      queryClient.invalidateQueries({ queryKey: ['system-options'] })
      toast.success(t('Upstream site saved'))
      setFormOpen(false)
    } catch {
      toast.error(t('Failed to update the upstream sites config'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deletingSite) return
    setDeleting(true)
    try {
      const resp = await updateSystemOption({
        key: UPSTREAM_PROBE_CONFIGS_OPTION_KEY,
        value: removeUpstreamProbeConfig(rawConfigs, deletingSite.base_url),
      })
      if (!resp.success) {
        throw new Error(resp.message)
      }
      queryClient.invalidateQueries({ queryKey: ['system-options'] })
      toast.success(t('Upstream site deleted'))
      // 清掉该站点的测试结果残留，避免日后同名站点显示过期结果
      const base = normalizeUpstreamBaseUrl(deletingSite.base_url)
      setTests((prev) => {
        const next = { ...prev }
        delete next[base]
        return next
      })
      setDeletingSite(null)
    } catch {
      toast.error(t('Failed to update the upstream sites config'))
    } finally {
      setDeleting(false)
    }
  }

  const handleTest = async (site: UpstreamProbeConfig) => {
    const base = normalizeUpstreamBaseUrl(site.base_url)
    setTests((prev) => ({ ...prev, [base]: { loading: true } }))
    try {
      const resp = await probeNewAPIUpstream({
        base_url: site.base_url,
        access_token: site.access_token || undefined,
        user_id: site.user_id || undefined,
      })
      if (!resp.success || !resp.data) {
        setTests((prev) => ({
          ...prev,
          [base]: {
            ok: false,
            text: resp.message || t('Failed to probe upstream site'),
          },
        }))
        return
      }
      const probeData = resp.data
      setTests((prev) => ({
        ...prev,
        [base]: {
          ok: true,
          text: t('{{models}} models, {{groups}} groups', {
            models: probeData.models.length,
            groups: Object.keys(probeData.group_ratio ?? {}).length,
          }),
        },
      }))
    } catch (error: unknown) {
      setTests((prev) => ({
        ...prev,
        [base]: {
          ok: false,
          text:
            error instanceof Error
              ? error.message
              : t('Failed to probe upstream site'),
        },
      }))
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className={sideDrawerContentClassName('sm:max-w-3xl')}>
        <SheetHeader className={sideDrawerHeaderClassName()}>
          <SheetTitle className='flex items-center gap-2'>
            {t('Upstream sites')}
            <Badge variant='secondary'>{sites.length}</Badge>
          </SheetTitle>
        </SheetHeader>
        <div className={sideDrawerFormClassName()}>
          <div className='space-y-4'>
            {!formOpen && (
              <Button size='sm' onClick={openAddForm}>
                <Plus className='h-4 w-4' />
                {t('Add upstream site')}
              </Button>
            )}

            {formOpen && (
              <div className='space-y-3 rounded-md border p-3'>
                <div className='text-sm font-semibold'>
                  {editingBase
                    ? t('Edit upstream site')
                    : t('Add upstream site')}
                </div>
                <div className='space-y-1.5'>
                  <Label htmlFor='upstream-site-base-url'>{t('Base URL')}</Label>
                  <Input
                    id='upstream-site-base-url'
                    placeholder='https://api.example.com'
                    value={formBaseUrl}
                    disabled={editingBase !== null}
                    onChange={(e) => setFormBaseUrl(e.target.value)}
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label htmlFor='upstream-site-user-id'>{t('User ID')}</Label>
                  <Input
                    id='upstream-site-user-id'
                    value={formUserId}
                    onChange={(e) => setFormUserId(e.target.value)}
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label htmlFor='upstream-site-token'>
                    {t('Probe access token')}
                  </Label>
                  <Input
                    id='upstream-site-token'
                    type='password'
                    autoComplete='off'
                    placeholder={
                      editingBase
                        ? t('Leave empty to keep the existing credential')
                        : ''
                    }
                    value={formToken}
                    onChange={(e) => setFormToken(e.target.value)}
                  />
                </div>
                <div className='flex items-center gap-2'>
                  <Button size='sm' onClick={handleSave} disabled={saving}>
                    {saving && (
                      <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    )}
                    {t('Save')}
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => setFormOpen(false)}
                    disabled={saving}
                  >
                    {t('Cancel')}
                  </Button>
                </div>
              </div>
            )}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Base URL')}</TableHead>
                  <TableHead>{t('User ID')}</TableHead>
                  <TableHead>{t('Probe access token')}</TableHead>
                  <TableHead>{t('Linked channels')}</TableHead>
                  <TableHead className='text-right'>{t('Actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sites.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className='text-muted-foreground py-8 text-center'
                    >
                      {t('No upstream sites configured yet')}
                    </TableCell>
                  </TableRow>
                )}
                {sites.map((site) => {
                  const base = normalizeUpstreamBaseUrl(site.base_url)
                  const stats = channelStatsFor(base)
                  const test = tests[base]
                  return (
                    <Fragment key={base}>
                      <TableRow>
                        <TableCell className='font-mono text-xs break-all'>
                          {site.base_url}
                        </TableCell>
                        <TableCell>{site.user_id || '-'}</TableCell>
                        <TableCell>
                          {site.access_token ? (
                            <Badge variant='secondary'>{t('Set')}</Badge>
                          ) : (
                            <Badge variant='outline'>{t('Not set')}</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className='inline-flex flex-wrap items-center gap-1.5'>
                            {stats.related}
                            {stats.missingGroup > 0 && (
                              <Badge
                                variant='outline'
                                className='border-amber-500 text-amber-600 dark:text-amber-500'
                              >
                                {t('{{count}} channel(s) missing upstream group', {
                                  count: stats.missingGroup,
                                })}
                              </Badge>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className='text-right'>
                          <div className='inline-flex items-center gap-1'>
                            <Button
                              variant='ghost'
                              size='sm'
                              className='h-7 px-2'
                              disabled={test?.loading}
                              onClick={() => handleTest(site)}
                            >
                              {test?.loading ? (
                                <Loader2 className='h-3.5 w-3.5 animate-spin' />
                              ) : (
                                <TestTube className='h-3.5 w-3.5' />
                              )}
                              {t('Test connection')}
                            </Button>
                            <Button
                              variant='ghost'
                              size='sm'
                              className='h-7 px-2'
                              onClick={() => openEditForm(site)}
                            >
                              <Pencil className='h-3.5 w-3.5' />
                              {t('Edit')}
                            </Button>
                            <Button
                              variant='ghost'
                              size='sm'
                              className='text-destructive h-7 px-2'
                              onClick={() => setDeletingSite(site)}
                            >
                              <Trash2 className='h-3.5 w-3.5' />
                              {t('Delete')}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {test && !test.loading && test.text && (
                        <TableRow>
                          <TableCell
                            colSpan={5}
                            className={
                              test.ok
                                ? 'text-xs text-green-600 dark:text-green-500'
                                : 'text-xs text-red-600 dark:text-red-500'
                            }
                          >
                            {test.text}
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      </SheetContent>

      <ConfirmDialog
        open={deletingSite !== null}
        onOpenChange={(v) => {
          if (!v) setDeletingSite(null)
        }}
        title={t('Delete upstream site?')}
        desc={t(
          'This only removes the probe credential; channels using this upstream are not affected.'
        )}
        destructive
        isLoading={deleting}
        handleConfirm={handleDelete}
      />
    </Sheet>
  )
}
