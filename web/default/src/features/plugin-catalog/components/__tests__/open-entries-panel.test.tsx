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
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import type {
  PluginCatalogDocument,
  PluginCatalogOwnedEntry,
} from '../../types'
import { OpenEntriesPanel } from '../open-entries-panel'

const ownedEntry: PluginCatalogOwnedEntry = {
  id: 'lawyer-filing',
  directory: 'packages/lawyer-filing',
  name: '立案助手',
  description: '批量立案材料体检与填报',
  category: '立案',
  enabled: true,
}

const communityEntry = {
  id: 'doc-review',
  owner: 'wuwenrui',
  repo: 'https://github.com/wuwenrui/dsh-plugin-doc-review',
  packageName: 'dsh-plugin-doc-review',
  version: '1.2.0',
  category: '法律',
  enabled: true,
}

const document: PluginCatalogDocument = {
  revision: 3,
  updatedAt: 1788969000,
  updatedBy: 'root',
  owned: [ownedEntry],
  community: [communityEntry],
  publishRequests: [],
}

function renderPanel(
  props: Partial<Parameters<typeof OpenEntriesPanel>[0]> = {}
) {
  const handlers = {
    onAddOwned: vi.fn(),
    onEditOwned: vi.fn(),
    onToggleOwned: vi.fn(),
    onDeleteOwned: vi.fn(),
    onOpenManual: vi.fn(),
    onEdit: vi.fn(),
    onToggle: vi.fn(),
    onDelete: vi.fn(),
  }
  render(
    <OpenEntriesPanel
      document={document}
      pending={false}
      {...handlers}
      {...props}
    />
  )
  return handlers
}

describe('plugin catalog open entries panel', () => {
  test('takes a first-party plugin out of the next release by reporting the disabled state', () => {
    const handlers = renderPanel()

    fireEvent.click(
      screen.getByRole('switch', {
        name: 'Include in the next release 立案助手',
      })
    )

    expect(handlers.onToggleOwned).toHaveBeenCalledWith(ownedEntry, false)
    expect(handlers.onToggle).not.toHaveBeenCalled()
  })

  test('edits a first-party plugin from its row', () => {
    const handlers = renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Edit 立案助手' }))

    expect(handlers.onEditOwned).toHaveBeenCalledWith(ownedEntry)
  })

  test('asks for confirmation before removing a first-party plugin', () => {
    const handlers = renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Remove 立案助手' }))

    expect(handlers.onDeleteOwned).toHaveBeenCalledWith(ownedEntry)
    expect(handlers.onDelete).not.toHaveBeenCalled()
  })

  test('shows the package directory the release pipeline packs', () => {
    renderPanel()

    expect(screen.getByText('packages/lawyer-filing')).toBeInTheDocument()
    expect(screen.getByText('批量立案材料体检与填报')).toBeInTheDocument()
  })

  test('opens the add dialog for a new first-party plugin', () => {
    const handlers = renderPanel()

    fireEvent.click(
      screen.getByRole('button', { name: 'Add a first-party plugin' })
    )

    expect(handlers.onAddOwned).toHaveBeenCalledTimes(1)
  })

  test('closes an open community plugin by reporting the disabled state', () => {
    const handlers = renderPanel()

    fireEvent.click(
      screen.getByRole('switch', { name: 'Available to users doc-review' })
    )

    expect(handlers.onToggle).toHaveBeenCalledWith(communityEntry, false)
  })

  test('shows the empty state when no community plugin is open', () => {
    renderPanel({ document: { ...document, community: [] } })

    expect(
      screen.getByText('No community plugin is open yet.')
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('switch', { name: 'Available to users doc-review' })
    ).toBeNull()
  })
})
