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
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { isChunkLoadError, markChunkErrorReload } from './chunk-load-error'

function makeMemoryStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
  }
}

describe('isChunkLoadError', () => {
  test('matches rspack/webpack ChunkLoadError by name', () => {
    const error = new Error('Loading chunk 7766 failed.')
    error.name = 'ChunkLoadError'
    assert.equal(isChunkLoadError(error), true)
  })

  test('matches chunk failure messages regardless of name', () => {
    for (const message of [
      'Loading chunk 7766 failed. (error: https://x/static/js/7766.abc.js)',
      'Loading CSS chunk 7766 failed. (/static/css/7766.abc.css)',
      'Failed to fetch dynamically imported module: https://x/a.js',
      'error loading dynamically imported module',
      'Importing a module script failed.',
    ]) {
      assert.equal(isChunkLoadError(new Error(message)), true, message)
    }
  })

  test('rejects unrelated errors and non-error values', () => {
    assert.equal(isChunkLoadError(new Error('Request failed with 500')), false)
    assert.equal(isChunkLoadError(new TypeError('x is not a function')), false)
    assert.equal(isChunkLoadError(null), false)
    assert.equal(isChunkLoadError('Loading chunk 1 failed'), false)
  })
})

describe('markChunkErrorReload', () => {
  test('allows one reload per path, then blocks repeats', () => {
    const storage = makeMemoryStorage()
    assert.equal(markChunkErrorReload('/system-settings', storage), true)
    assert.equal(markChunkErrorReload('/system-settings', storage), false)
    // A different stale route may still recover once.
    assert.equal(markChunkErrorReload('/channels', storage), true)
  })

  test('returns false when storage is unavailable', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    assert.equal(markChunkErrorReload('/x', broken), false)
  })
})
