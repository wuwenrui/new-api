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

// After a deploy replaces hashed assets, SPA tabs loaded before the deploy
// fail to lazy-load route chunks. Detect that failure so the error page can
// recover with a one-time full reload instead of a dead "500" screen.

const RELOAD_FLAG_KEY = 'chunk-load-error-reloaded-path'

const CHUNK_ERROR_PATTERNS = [
  /loading (css )?chunk .* failed/i,
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
]

export function isChunkLoadError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { name, message } = error as { name?: unknown; message?: unknown }
  if (name === 'ChunkLoadError') return true
  if (typeof message !== 'string') return false
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

// Returns true when a reload should be attempted for this path. The flag is
// keyed by path so a chunk that is still broken after reloading (a real bug,
// not a stale deploy) does not cause an infinite reload loop.
export function markChunkErrorReload(
  path: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage
): boolean {
  try {
    if (storage.getItem(RELOAD_FLAG_KEY) === path) return false
    storage.setItem(RELOAD_FLAG_KEY, path)
    return true
  } catch {
    return false
  }
}
