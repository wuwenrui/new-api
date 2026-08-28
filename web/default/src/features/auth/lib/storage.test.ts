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
import { describe, expect, test } from 'vitest'

import { getUserId, removeUserId, saveUserId } from './storage'

function makeMemoryStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    get length() {
      return store.size
    },
    key: (index: number) => [...store.keys()][index] ?? null,
  }
}

// Minimal document.cookie stand-in honoring the max-age=0 delete convention.
function makeCookieJar() {
  const jar = new Map<string, string>()
  return {
    get cookie() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    },
    set cookie(value: string) {
      const [pair, ...attrs] = value.split(';')
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq).trim()
      const val = pair.slice(eq + 1).trim()
      const maxAge = attrs
        .map((attr) => attr.trim().toLowerCase())
        .find((attr) => attr.startsWith('max-age='))
      if (maxAge && Number(maxAge.slice('max-age='.length)) <= 0) {
        jar.delete(name)
      } else {
        jar.set(name, val)
      }
    },
  }
}

function setup() {
  const storage = makeMemoryStorage()
  const jar = makeCookieJar()
  ;(globalThis as { window?: unknown }).window = { localStorage: storage }
  ;(globalThis as { document?: unknown }).document = jar
  return { storage, jar }
}

describe('auth storage uid backup and recovery', () => {
  test('saveUserId writes localStorage and mirrors the uid cookie', () => {
    const { storage, jar } = setup()

    saveUserId(1)

    expect(storage.getItem('uid')).toBe('1')
    expect(jar.cookie).toMatch(/(?:^|; )napi_uid=1(?:;|$)/)
  })

  test('getUserId prefers the localStorage value over backups', () => {
    const { storage, jar } = setup()
    storage.setItem('uid', '7')
    jar.cookie = 'napi_uid=9; path=/; max-age=60'

    expect(getUserId()).toBe('7')
  })

  test('getUserId recovers from the uid cookie after a full wipe and heals localStorage', () => {
    const { storage } = setup()
    saveUserId(1)

    storage.clear()

    expect(getUserId()).toBe('1')
    expect(storage.getItem('uid')).toBe('1')
  })

  test('getUserId recovers from the persisted user payload after a partial wipe', () => {
    const { storage, jar } = setup()
    storage.setItem('user', JSON.stringify({ id: 42, username: 'u' }))

    expect(getUserId()).toBe('42')
    expect(storage.getItem('uid')).toBe('42')
    expect(jar.cookie).toMatch(/(?:^|; )napi_uid=42(?:;|$)/)
  })

  test('getUserId falls back to the cookie when the user payload is corrupt', () => {
    const { storage, jar } = setup()
    storage.setItem('user', '{not json')
    jar.cookie = 'napi_uid=5; path=/; max-age=60'

    expect(getUserId()).toBe('5')
    expect(storage.getItem('uid')).toBe('5')
  })

  test('getUserId returns null when no backup exists', () => {
    setup()

    expect(getUserId()).toBeNull()
  })

  test('removeUserId clears both localStorage and the uid cookie', () => {
    const { storage, jar } = setup()
    saveUserId(1)

    removeUserId()

    expect(storage.getItem('uid')).toBeNull()
    expect(jar.cookie).not.toMatch(/napi_uid=/)
    expect(getUserId()).toBeNull()
  })
})
