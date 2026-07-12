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
/**
 * Utilities for managing authentication-related browser storage
 */

// ============================================================================
// LocalStorage Keys
// ============================================================================

const STORAGE_KEYS = {
  USER_ID: 'uid',
  AFFILIATE: 'aff',
  STATUS: 'status',
} as const

// ============================================================================
// User ID Storage
// ============================================================================

// The uid is mirrored into a plain cookie because third-party extensions
// occasionally wipe this site's localStorage wholesale while the backend
// session cookie stays valid. Requests without the New-Api-User header are
// rejected by middleware/auth.go, so losing the uid logs the user out even
// though their session is still alive. The cookie value is just the numeric
// user id (not a secret) and lets us restore the uid after such a wipe.
const UID_COOKIE_NAME = 'napi_uid'
const UID_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

function writeUidCookie(userId: string): void {
  document.cookie = `${UID_COOKIE_NAME}=${encodeURIComponent(userId)}; path=/; max-age=${UID_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`
}

function clearUidCookie(): void {
  document.cookie = `${UID_COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax`
}

function readUidCookie(): string | null {
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${UID_COOKIE_NAME}=([^;]*)`)
  )
  const value = match ? decodeURIComponent(match[1]) : ''
  return value || null
}

/**
 * Recover the user ID after a localStorage wipe, from the persisted user
 * payload (survives partial wipes) or the uid cookie (survives full wipes)
 */
function recoverUserId(): string | null {
  try {
    const rawUser = window.localStorage.getItem('user')
    if (rawUser) {
      const id = (JSON.parse(rawUser) as { id?: number | string }).id
      if (id !== undefined && id !== null && String(id) !== '') {
        return String(id)
      }
    }
  } catch {
    // Corrupt user payload; fall back to the cookie mirror.
  }
  return readUidCookie()
}

/**
 * Save user ID to localStorage and mirror it into the uid cookie
 */
export function saveUserId(userId: number | string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEYS.USER_ID, String(userId))
    writeUidCookie(String(userId))
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to save user ID:', error)
  }
}

/**
 * Get user ID from localStorage, restoring it from backups when missing
 */
export function getUserId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.localStorage.getItem(STORAGE_KEYS.USER_ID)
    if (stored) return stored
    const recovered = recoverUserId()
    if (recovered) {
      window.localStorage.setItem(STORAGE_KEYS.USER_ID, recovered)
      writeUidCookie(recovered)
    }
    return recovered
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to get user ID:', error)
    return null
  }
}

/**
 * Remove user ID from localStorage and clear the uid cookie
 */
export function removeUserId(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEYS.USER_ID)
    clearUidCookie()
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to remove user ID:', error)
  }
}

// ============================================================================
// Affiliate Code Storage
// ============================================================================

/**
 * Get affiliate code from localStorage
 */
export function getAffiliateCode(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(STORAGE_KEYS.AFFILIATE) ?? ''
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to get affiliate code:', error)
    return ''
  }
}

/**
 * Save affiliate code to localStorage
 */
export function saveAffiliateCode(code: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEYS.AFFILIATE, code)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to save affiliate code:', error)
  }
}
