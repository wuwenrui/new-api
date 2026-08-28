import { describe, expect, test } from 'vitest'
import {
  canViewInternalBillingDetails,
  getVisibleGroupRatioText,
} from './internal-billing-visibility'

describe('internal billing visibility', () => {
  test('allows only admins to view internal billing details', () => {
    expect(canViewInternalBillingDetails(undefined)).toBe(false)
    expect(canViewInternalBillingDetails(1)).toBe(false)
    expect(canViewInternalBillingDetails(10)).toBe(true)
    expect(canViewInternalBillingDetails(100)).toBe(true)
  })

  test('hides group ratio text from non-admin users', () => {
    const other = { group_ratio: 2, user_group_ratio: -1 }

    expect(getVisibleGroupRatioText(other, false)).toBeNull()
    expect(getVisibleGroupRatioText(other, true)).toBe('2x')
  })

  test('prefers user exclusive ratio for admins', () => {
    const other = { group_ratio: 2, user_group_ratio: 1.5 }

    expect(getVisibleGroupRatioText(other, true)).toBe('1.5x')
  })
})
