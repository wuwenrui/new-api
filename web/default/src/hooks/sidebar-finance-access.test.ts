import { describe, expect, test } from 'vitest'
import { ROLE } from '@/lib/roles'
import { canAccessFinanceReport } from './sidebar-finance-access'

describe('finance report sidebar access', () => {
  test('allows admin and super admin users only', () => {
    expect(canAccessFinanceReport(ROLE.SUPER_ADMIN)).toBe(true)
    expect(canAccessFinanceReport(ROLE.ADMIN)).toBe(true)
    expect(canAccessFinanceReport(ROLE.USER)).toBe(false)
    expect(canAccessFinanceReport(ROLE.GUEST)).toBe(false)
    expect(canAccessFinanceReport(undefined)).toBe(false)
  })
})
