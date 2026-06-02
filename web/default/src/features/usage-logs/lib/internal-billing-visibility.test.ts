import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  canViewInternalBillingDetails,
  getVisibleGroupRatioText,
} from './internal-billing-visibility'

describe('internal billing visibility', () => {
  test('allows only admins to view internal billing details', () => {
    assert.equal(canViewInternalBillingDetails(undefined), false)
    assert.equal(canViewInternalBillingDetails(1), false)
    assert.equal(canViewInternalBillingDetails(10), true)
    assert.equal(canViewInternalBillingDetails(100), true)
  })

  test('hides group ratio text from non-admin users', () => {
    const other = { group_ratio: 2, user_group_ratio: -1 }

    assert.equal(getVisibleGroupRatioText(other, false), null)
    assert.equal(getVisibleGroupRatioText(other, true), '2x')
  })

  test('prefers user exclusive ratio for admins', () => {
    const other = { group_ratio: 2, user_group_ratio: 1.5 }

    assert.equal(getVisibleGroupRatioText(other, true), '1.5x')
  })
})
