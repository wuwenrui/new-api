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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { searchCommunityCatalog } from '../../api'
import type { PluginCatalogCommunityResult } from '../../types'
import { CommunityCatalogPanel } from '../community-catalog-panel'

vi.mock('../../api', () => ({
  searchCommunityCatalog: vi.fn(),
}))

const searchMock = vi.mocked(searchCommunityCatalog)

const contractPlugin: PluginCatalogCommunityResult = {
  name: 'contract-review',
  owner: 'wuwenrui',
  repo: 'https://github.com/wuwenrui/dsh-plugin-contract-review',
  packageName: 'dsh-plugin-contract-review',
  version: '2.0.1',
  category: '法律',
  description: '合同审阅',
  hasTarball: true,
  deprecated: false,
  alreadyOpen: false,
}

function renderPanel() {
  const onOpenEntry = vi.fn()
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <CommunityCatalogPanel onOpenEntry={onOpenEntry} />
    </QueryClientProvider>
  )
  return { onOpenEntry }
}

describe('plugin catalog community search panel', () => {
  beforeEach(() => {
    searchMock.mockReset()
    searchMock.mockResolvedValue([contractPlugin])
  })

  test('searches the trimmed query and renders the matching plugin', async () => {
    renderPanel()

    fireEvent.change(screen.getByLabelText('Search the community catalog'), {
      target: { value: '  合同  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => {
      expect(searchMock).toHaveBeenLastCalledWith('合同')
    })
    expect(await screen.findByText('contract-review')).toBeInTheDocument()
    expect(screen.getByText('dsh-plugin-contract-review')).toBeInTheDocument()
  })

  test('marks an already opened plugin and asks the caller to update it', async () => {
    searchMock.mockResolvedValue([
      { ...contractPlugin, alreadyOpen: true, openEnabled: true },
    ])
    const { onOpenEntry } = renderPanel()

    expect(await screen.findByText('Opened · enabled')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    expect(onOpenEntry).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: 'dsh-plugin-contract-review' })
    )
  })

  test('shows the upstream failure message when the community catalog is unavailable', async () => {
    searchMock.mockRejectedValue(new Error('社区目录暂不可用（HTTP 502）'))
    renderPanel()

    expect(
      await screen.findByText('社区目录暂不可用（HTTP 502）')
    ).toBeInTheDocument()
  })
})
