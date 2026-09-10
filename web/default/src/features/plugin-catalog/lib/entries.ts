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
import type {
  PluginCatalogCommunityEntry,
  PluginCatalogCommunityResult,
} from '../types'

/**
 * Builds the openable entry from one upstream catalog hit. The upstream catalog
 * names plugins in title case, while the signed registry expects the lowercase
 * slug the desktop product resolves, so the name is normalized here.
 */
export function entryFromSearchResult(
  result: PluginCatalogCommunityResult
): PluginCatalogCommunityEntry {
  return {
    id: result.name.trim().toLowerCase(),
    owner: result.owner,
    repo: result.repo,
    packageName: result.packageName,
    version: result.version,
    category: result.category || '社区',
    enabled: true,
  }
}
