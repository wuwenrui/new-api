import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { getVisibleGroupRatioSuffix } from '../lib/group-ratio-visibility'

describe('pricing sidebar group ratio visibility', () => {
  test('hides group ratio suffix from non-admin users', () => {
    assert.equal(getVisibleGroupRatioSuffix(2, false), undefined)
  })

  test('shows group ratio suffix to admins', () => {
    assert.equal(getVisibleGroupRatioSuffix(2, true), 'x2')
  })
})
