import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ROLE } from '@/lib/roles'
import { canAccessFinanceReport } from './sidebar-finance-access'

describe('finance report sidebar access', () => {
  test('allows admin and super admin users only', () => {
    assert.equal(canAccessFinanceReport(ROLE.SUPER_ADMIN), true)
    assert.equal(canAccessFinanceReport(ROLE.ADMIN), true)
    assert.equal(canAccessFinanceReport(ROLE.USER), false)
    assert.equal(canAccessFinanceReport(ROLE.GUEST), false)
    assert.equal(canAccessFinanceReport(undefined), false)
  })
})
