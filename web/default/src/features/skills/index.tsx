import axios from 'axios'
import {
  Download,
  Edit3,
  LockKeyhole,
  PackageOpen,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'

import { Main } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Textarea } from '@/components/ui/textarea'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import {
  createSkill,
  deleteSkill,
  downloadSkill,
  fetchAccessibleSkills,
  fetchSkillGrantUsers,
  readSkillFileAsBase64,
  updateSkill,
} from './api'
import type {
  Skill,
  SkillGrantUser,
  SkillVisibility,
  SkillWritePayload,
} from './types'

export function SkillsPage() {
  const role = useAuthStore((state) => state.auth.user?.role ?? ROLE.GUEST)
  const isAdmin = role >= ROLE.ADMIN
  const [skills, setSkills] = useState<Skill[]>([])
  const [users, setUsers] = useState<SkillGrantUser[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [editingSkill, setEditingSkill] = useState<Skill | null | undefined>()

  const loadSkills = useCallback(async (search = '') => {
    setLoading(true)
    try {
      const result = await fetchAccessibleSkills(search)
      setSkills(result.items)
    } catch (error) {
      toast.error(skillErrorMessage(error, '获取 Skill 列表失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  useEffect(() => {
    if (!isAdmin) return
    void fetchSkillGrantUsers()
      .then(setUsers)
      .catch((error) =>
        toast.error(skillErrorMessage(error, '获取用户列表失败'))
      )
  }, [isAdmin])

  const handleSearch = (event: FormEvent) => {
    event.preventDefault()
    void loadSkills(query.trim())
  }

  const handleDelete = async (skill: Skill) => {
    if (!window.confirm(`确认删除“${skill.display_name}”？此操作不可撤销。`)) {
      return
    }
    try {
      await deleteSkill(skill.id)
      toast.success('Skill 已删除')
      await loadSkills(query.trim())
    } catch (error) {
      toast.error(skillErrorMessage(error, '删除 Skill 失败'))
    }
  }

  const handleDownload = async (skill: Skill) => {
    try {
      await downloadSkill(skill)
    } catch (error) {
      toast.error(skillErrorMessage(error, '下载 Skill 失败'))
    }
  }

  return (
    <Main>
      <div className='min-h-0 flex-1 overflow-auto px-4 py-6 sm:px-6'>
        <div className='mx-auto flex w-full max-w-7xl flex-col gap-6'>
          <header className='flex flex-col gap-4 border-b pb-6 md:flex-row md:items-end md:justify-between'>
            <div className='space-y-2'>
              <div className='text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-[0.2em] uppercase'>
                <ShieldCheck className='size-4' />
                律师工作方法库
              </div>
              <h1 className='text-3xl font-semibold tracking-tight'>
                Skill 市场
              </h1>
              <p className='text-muted-foreground max-w-2xl text-sm leading-6'>
                获取已经整理好的办案方法。公开 Skill
                对所有模型站点用户可见，私有 Skill 由管理员指定人员。
              </p>
            </div>
            {isAdmin && (
              <Button onClick={() => setEditingSkill(null)}>
                <Plus className='size-4' />
                新增 Skill
              </Button>
            )}
          </header>

          <form onSubmit={handleSearch} className='flex max-w-xl gap-2'>
            <div className='relative flex-1'>
              <Search className='text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2' />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder='搜索名称或说明'
                className='pl-9'
              />
            </div>
            <Button type='submit' variant='outline'>
              搜索
            </Button>
          </form>

          {loading && (
            <div className='text-muted-foreground py-16 text-center text-sm'>
              正在读取 Skill…
            </div>
          )}
          {!loading && skills.length === 0 && (
            <div className='rounded-xl border border-dashed py-20 text-center'>
              <PackageOpen className='text-muted-foreground mx-auto mb-3 size-10' />
              <p className='font-medium'>没有找到可用的 Skill</p>
              <p className='text-muted-foreground mt-1 text-sm'>
                换个关键词，或请管理员为你开放。
              </p>
            </div>
          )}
          {!loading && skills.length > 0 && (
            <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-3'>
              {skills.map((skill) => (
                <Card key={skill.id} className='flex min-h-56 flex-col'>
                  <CardHeader className='space-y-3'>
                    <div className='flex items-start justify-between gap-3'>
                      <CardTitle className='text-lg leading-6'>
                        {skill.display_name}
                      </CardTitle>
                      <Badge
                        variant={
                          skill.visibility === 'public'
                            ? 'secondary'
                            : 'outline'
                        }
                      >
                        {skill.visibility === 'public' ? '公开' : '指定用户'}
                      </Badge>
                    </div>
                    <div className='text-muted-foreground flex items-center gap-2 text-xs'>
                      {skill.visibility === 'private' && (
                        <LockKeyhole className='size-3.5' />
                      )}
                      <span>版本 {skill.latest_version}</span>
                      {skill.author && <span>· {skill.author}</span>}
                    </div>
                  </CardHeader>
                  <CardContent className='flex flex-1 flex-col justify-between gap-5'>
                    <p className='text-muted-foreground line-clamp-4 text-sm leading-6'>
                      {skill.description || '暂无说明'}
                    </p>
                    <div className='flex flex-wrap gap-2'>
                      <Button
                        size='sm'
                        onClick={() => void handleDownload(skill)}
                      >
                        <Download className='size-4' />
                        下载
                      </Button>
                      {isAdmin && (
                        <>
                          <Button
                            size='sm'
                            variant='outline'
                            onClick={() => setEditingSkill(skill)}
                          >
                            <Edit3 className='size-4' />
                            编辑
                          </Button>
                          <Button
                            size='sm'
                            variant='ghost'
                            onClick={() => void handleDelete(skill)}
                          >
                            <Trash2 className='size-4' />
                            删除
                          </Button>
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      {isAdmin && editingSkill !== undefined && (
        <SkillEditorDialog
          skill={editingSkill}
          users={users}
          onOpenChange={(open) => !open && setEditingSkill(undefined)}
          onSaved={async () => {
            setEditingSkill(undefined)
            await loadSkills(query.trim())
          }}
        />
      )}
    </Main>
  )
}

type SkillEditorDialogProps = {
  skill: Skill | null
  users: SkillGrantUser[]
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}

function SkillEditorDialog({
  skill,
  users,
  onOpenChange,
  onSaved,
}: SkillEditorDialogProps) {
  const [name, setName] = useState(skill?.name ?? '')
  const [displayName, setDisplayName] = useState(skill?.display_name ?? '')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [authorName, setAuthorName] = useState(skill?.author ?? '')
  const [visibility, setVisibility] = useState<SkillVisibility>(
    skill?.visibility ?? 'private'
  )
  const [selectedUserIDs, setSelectedUserIDs] = useState<number[]>(
    skill?.user_ids ?? []
  )
  const [zipFile, setZipFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!skill && !zipFile) {
      toast.error('请选择 Skill ZIP 文件')
      return
    }
    setSaving(true)
    try {
      const payload: SkillWritePayload = {
        name: name.trim(),
        display_name: displayName.trim(),
        description: description.trim(),
        visibility,
        author_name: authorName.trim(),
        content_b64: zipFile ? await readSkillFileAsBase64(zipFile) : '',
        user_ids: visibility === 'private' ? selectedUserIDs : [],
      }
      if (skill) {
        await updateSkill(skill.id, payload)
      } else {
        await createSkill(payload)
      }
      toast.success(skill ? 'Skill 已更新' : 'Skill 已创建')
      await onSaved()
    } catch (error) {
      toast.error(
        skillErrorMessage(error, skill ? '更新 Skill 失败' : '创建 Skill 失败')
      )
    } finally {
      setSaving(false)
    }
  }

  const toggleUser = (userID: number, checked: boolean) => {
    setSelectedUserIDs((current) =>
      checked ? [...current, userID] : current.filter((id) => id !== userID)
    )
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <form onSubmit={submit} className='space-y-5'>
          <DialogHeader>
            <DialogTitle>{skill ? '编辑 Skill' : '新增 Skill'}</DialogTitle>
            <DialogDescription>
              上传当前版本，并决定公开或仅指定用户可见。
            </DialogDescription>
          </DialogHeader>

          <div className='grid gap-4 sm:grid-cols-2'>
            <Field label='内部名称' htmlFor='skill-name'>
              <Input
                id='skill-name'
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </Field>
            <Field label='显示名称' htmlFor='skill-display-name'>
              <Input
                id='skill-display-name'
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </Field>
          </div>
          <Field label='说明' htmlFor='skill-description'>
            <Textarea
              id='skill-description'
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
            />
          </Field>
          <div className='grid gap-4 sm:grid-cols-2'>
            <Field label='作者名称' htmlFor='skill-author'>
              <Input
                id='skill-author'
                value={authorName}
                onChange={(event) => setAuthorName(event.target.value)}
              />
            </Field>
            <Field label='可见范围' htmlFor='skill-visibility'>
              <select
                id='skill-visibility'
                value={visibility}
                onChange={(event) =>
                  setVisibility(event.target.value as SkillVisibility)
                }
                className='border-input bg-background h-9 w-full rounded-md border px-3 text-sm'
              >
                <option value='public'>所有用户</option>
                <option value='private'>指定用户</option>
              </select>
            </Field>
          </div>
          <Field
            label={skill ? '替换 ZIP（不选则保留当前版本）' : 'Skill ZIP'}
            htmlFor='skill-file'
          >
            <Input
              id='skill-file'
              type='file'
              accept='.zip,application/zip'
              onChange={(event) => setZipFile(event.target.files?.[0] ?? null)}
            />
          </Field>

          {visibility === 'private' && (
            <div className='space-y-2'>
              <Label>可见用户</Label>
              <div className='grid max-h-48 gap-2 overflow-y-auto rounded-lg border p-3 sm:grid-cols-2'>
                {users.map((user) => (
                  <label
                    key={user.id}
                    className='hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm'
                  >
                    <Checkbox
                      checked={selectedUserIDs.includes(user.id)}
                      onCheckedChange={(checked) =>
                        toggleUser(user.id, checked === true)
                      }
                    />
                    <span className='truncate'>
                      {user.display_name || user.username}
                    </span>
                    {user.display_name && (
                      <span className='text-muted-foreground truncate text-xs'>
                        ({user.username})
                      </span>
                    )}
                  </label>
                ))}
                {users.length === 0 && (
                  <p className='text-muted-foreground text-sm'>暂无可选用户</p>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button type='submit' disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div className='space-y-2'>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}

function skillErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail
    if (typeof detail === 'string' && detail) return detail
  }
  return fallback
}
