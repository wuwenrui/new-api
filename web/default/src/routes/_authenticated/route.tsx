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
import { createFileRoute, redirect } from '@tanstack/react-router'

import { AuthenticatedLayout } from '@/components/layout'
import { getUserId, saveUserId } from '@/features/auth/lib/storage'
import { getSelf } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

// 内存中的验证标记，避免同一会话中重复验证
let sessionVerified = false

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ location }) => {
    const { auth } = useAuthStore.getState()

    // 本地没有用户信息时，可能是第三方扩展清空了 localStorage 而
    // session cookie 仍有效：若能从备份（user 快照 / uid cookie）恢复
    // uid，则先尝试用 session 拉回用户信息，失败才跳转登录页
    if (!auth.user) {
      const res = getUserId() ? await getSelf().catch(() => null) : null
      if (res?.success && res.data) {
        auth.setUser(res.data)
        saveUserId(res.data.id)
        sessionVerified = true
      } else {
        throw redirect({
          to: '/sign-in',
          search: { redirect: location.href },
        })
      }
    }

    // 本地有用户信息，但需要验证 session 是否有效（每个会话只验证一次）
    if (!sessionVerified) {
      // 仅 401 视为 session 失效；网络错误/超时/5xx 返回 null 放行，下次导航重验
      const res = await getSelf().catch((err: unknown) =>
        (err as { response?: { status?: number } })?.response?.status === 401
          ? { success: false }
          : null
      )
      if (res?.success && res.data) {
        // 验证成功，更新用户信息（可能有变化）；同时补写 uid 备份
        // cookie，让改动上线前就已登录的会话也获得 localStorage 清空防护
        auth.setUser(res.data)
        saveUserId(res.data.id)
        sessionVerified = true
      } else if (res) {
        // 验证失败，清除本地缓存并跳转登录页
        auth.reset()
        throw redirect({
          to: '/sign-in',
          search: { redirect: location.href },
        })
      }
    }
  },
  component: AuthenticatedLayout,
})
