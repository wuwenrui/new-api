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
export type ApiResponse<T> = {
  success: boolean
  message?: string
  data?: T
}

/** Pinned community artifact the signed catalog hands to the desktop product. */
export type PluginCatalogTarball = {
  url: string
  sha256: string
  size: number
}

/** One community plugin the operator opened for the product. */
export type PluginCatalogCommunityEntry = {
  id: string
  owner: string
  repo: string
  packageName: string
  version: string
  category: string
  enabled: boolean
  tarball?: PluginCatalogTarball
}

/**
 * One first-party plugin published by our own release pipeline. The fields
 * mirror the operator list the publisher packs from, so what is saved here is
 * exactly what the release machine packs; the version always comes from the
 * plugin's own package manifest.
 */
export type PluginCatalogOwnedEntry = {
  id: string
  directory: string
  name: string
  description: string
  category: string
  enabled: boolean
}

export type PluginCatalogPublishRequest = {
  id: string
  revision: number
  requestedAt: number
  requestedBy: string
  note: string
  status: string
  detail?: string
}

/** The whole registry document the publisher signs. */
export type PluginCatalogDocument = {
  revision: number
  updatedAt: number
  updatedBy: string
  owned: PluginCatalogOwnedEntry[]
  community: PluginCatalogCommunityEntry[]
  publishRequests: PluginCatalogPublishRequest[]
}

/** One search hit from the upstream community catalog. */
export type PluginCatalogCommunityResult = {
  name: string
  owner: string
  repo: string
  packageName: string
  version: string
  category: string
  description: string
  hasTarball: boolean
  deprecated: boolean
  alreadyOpen: boolean
  openVersion?: string
  openEnabled?: boolean
  compatibility?: string
}
