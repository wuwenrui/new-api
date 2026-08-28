import { describe, expect, test } from 'vitest'
import { getVisibleGroupRatioSuffix } from '../lib/group-ratio-visibility'

describe('pricing sidebar group ratio visibility', () => {
  test('hides group ratio suffix from non-admin users', () => {
    expect(getVisibleGroupRatioSuffix(2, false)).toBeUndefined()
  })

  test('shows group ratio suffix to admins', () => {
    expect(getVisibleGroupRatioSuffix(2, true)).toBe('x2')
  })
})
