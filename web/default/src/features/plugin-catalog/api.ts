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
import { api, type ApiRequestConfig } from '@/lib/api'

import type {
  ApiResponse,
  PluginCatalogCommunityEntry,
  PluginCatalogCommunityResult,
  PluginCatalogDocument,
  PluginCatalogOwnedEntry,
} from './types'

const mutationConfig: ApiRequestConfig = {
  skipBusinessError: true,
  skipErrorHandler: true,
}

function requireSuccess<T>(response: ApiResponse<T>): T {
  if (!response.success) throw new Error(response.message || 'Request failed')
  return response.data as T
}

export async function getPluginCatalog(): Promise<PluginCatalogDocument> {
  const response = await api.get<ApiResponse<PluginCatalogDocument>>(
    '/api/plugin/catalog'
  )
  return requireSuccess(response.data)
}

export async function searchCommunityCatalog(
  query: string
): Promise<PluginCatalogCommunityResult[]> {
  const response = await api.get<ApiResponse<PluginCatalogCommunityResult[]>>(
    '/api/plugin/catalog/community/search',
    { params: { q: query } }
  )
  return requireSuccess(response.data)
}

export async function upsertOwnedEntry(
  entry: PluginCatalogOwnedEntry
): Promise<PluginCatalogDocument> {
  const response = await api.post<ApiResponse<PluginCatalogDocument>>(
    '/api/plugin/catalog/owned',
    entry,
    mutationConfig
  )
  return requireSuccess(response.data)
}

export async function deleteOwnedEntry(
  id: string
): Promise<PluginCatalogDocument> {
  const response = await api.delete<ApiResponse<PluginCatalogDocument>>(
    `/api/plugin/catalog/owned/${encodeURIComponent(id)}`,
    mutationConfig
  )
  return requireSuccess(response.data)
}

export async function upsertCommunityEntry(
  entry: PluginCatalogCommunityEntry
): Promise<PluginCatalogDocument> {
  const response = await api.post<ApiResponse<PluginCatalogDocument>>(
    '/api/plugin/catalog/community',
    entry,
    mutationConfig
  )
  return requireSuccess(response.data)
}

export async function deleteCommunityEntry(
  id: string
): Promise<PluginCatalogDocument> {
  const response = await api.delete<ApiResponse<PluginCatalogDocument>>(
    `/api/plugin/catalog/community/${encodeURIComponent(id)}`,
    mutationConfig
  )
  return requireSuccess(response.data)
}

export async function requestPublish(
  note: string
): Promise<PluginCatalogDocument['publishRequests']> {
  const response = await api.post<
    ApiResponse<PluginCatalogDocument['publishRequests']>
  >('/api/plugin/catalog/publish', { note }, mutationConfig)
  return requireSuccess(response.data)
}

async function download(path: string, filename: string): Promise<void> {
  const response = await api.get<Blob>(path, { responseType: 'blob' })
  const url = URL.createObjectURL(response.data)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/** Download the operator list the release pipeline packs first-party plugins from. */
export function downloadOwnedRegistry(): Promise<void> {
  return download('/api/plugin/catalog/owned/export', 'approved.json')
}

/** Download the community allowlist the release pipeline resolves into the catalog. */
export function downloadCommunityRegistry(): Promise<void> {
  return download('/api/plugin/catalog/export', 'community-approved.json')
}
