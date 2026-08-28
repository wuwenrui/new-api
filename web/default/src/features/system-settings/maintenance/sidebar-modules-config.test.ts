import { describe, expect, test } from 'vitest'
import { parseSidebarModulesAdmin, SIDEBAR_MODULES_DEFAULT } from './config'

describe('sidebar modules admin config', () => {
  test('includes finance report in the default admin modules', () => {
    expect(SIDEBAR_MODULES_DEFAULT.admin.finance).toBe(true)
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

    expect(legacyConfig.admin.finance).toBe(true)
  })
})
