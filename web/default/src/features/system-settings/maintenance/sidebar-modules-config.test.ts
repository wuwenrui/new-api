import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseSidebarModulesAdmin, SIDEBAR_MODULES_DEFAULT } from './config'

describe('sidebar modules admin config', () => {
  test('includes finance report in the default admin modules', () => {
    assert.equal(SIDEBAR_MODULES_DEFAULT.admin.finance, true)
  })

  test('merges finance report into legacy sidebar module settings', () => {
    const legacyConfig = parseSidebarModulesAdmin(
      JSON.stringify({
        admin: {
          enabled: true,
          channel: true,
        },
      })
    )

    assert.equal(legacyConfig.admin.finance, true)
  })
})
