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
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import {
  downloadCommunityRegistry,
  downloadOwnedRegistry,
  upsertCommunityEntry,
} from '../api'
import type { PluginCatalogCommunityEntry } from '../types'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))

const entry: PluginCatalogCommunityEntry = {
  id: 'doc-review',
  owner: 'wuwenrui',
  repo: 'https://github.com/wuwenrui/dsh-plugin-doc-review',
  packageName: 'dsh-plugin-doc-review',
  version: '1.2.0',
  category: '法律',
  enabled: true,
}

describe('plugin catalog api', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
    vi.mocked(api.post).mockReset()
    vi.mocked(api.delete).mockReset()
  })

  test('surfaces the server message when the registry rejects an entry', async () => {
    vi.mocked(api.post).mockResolvedValue({
      data: {
        success: false,
        message: '插件标识必须是 3–80 位小写字母、数字或连字符',
      },
    } as never)

    await expect(upsertCommunityEntry(entry)).rejects.toThrow(
      '插件标识必须是 3–80 位小写字母、数字或连字符'
    )
  })

  // The release machine expects exact file names, so the anchor the download
  // creates is captured rather than only counting the click.
  function captureDownload(blob: Blob) {
    vi.mocked(api.get).mockResolvedValue({ data: blob } as never)
    const createObjectURL = vi.fn(() => 'blob:plugin-catalog')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const anchors: HTMLAnchorElement[] = []
    const createElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(
      (tagName: string) => {
        const element = createElement(tagName)
        if (tagName === 'a') anchors.push(element as HTMLAnchorElement)
        return element
      }
    )
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    return { anchors, click, createObjectURL, revokeObjectURL }
  }

  test('downloads the operator list the release pipeline packs as approved.json', async () => {
    const blob = new Blob(['[{"id":"lawyer-filing"}]'], {
      type: 'application/json',
    })
    const download = captureDownload(blob)

    await downloadOwnedRegistry()

    expect(api.get).toHaveBeenCalledWith('/api/plugin/catalog/owned/export', {
      responseType: 'blob',
    })
    expect(download.anchors[0]?.download).toBe('approved.json')
    expect(download.createObjectURL).toHaveBeenCalledWith(blob)
    expect(download.click).toHaveBeenCalledTimes(1)
    expect(download.revokeObjectURL).toHaveBeenCalledWith('blob:plugin-catalog')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test('downloads the community allowlist as community-approved.json', async () => {
    const blob = new Blob(['{"schemaVersion":1}'], { type: 'application/json' })
    const download = captureDownload(blob)

    await downloadCommunityRegistry()

    expect(api.get).toHaveBeenCalledWith('/api/plugin/catalog/export', {
      responseType: 'blob',
    })
    expect(download.anchors[0]?.download).toBe('community-approved.json')
    expect(download.click).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
})
