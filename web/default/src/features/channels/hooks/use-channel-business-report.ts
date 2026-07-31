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
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { getChannelBusinessReport } from '../api'
import type { ChannelBusinessReport, ChannelBusinessRow } from '../types'

export const CHANNEL_BUSINESS_REPORT_DAYS = 30

export function useChannelBusinessReport(days = CHANNEL_BUSINESS_REPORT_DAYS) {
  const query = useQuery({
    queryKey: ['channel-business-report', days],
    queryFn: () => getChannelBusinessReport(days),
    staleTime: 60 * 1000,
  })

  const report: ChannelBusinessReport | undefined = query.data?.data

  const rowByChannelId = useMemo(() => {
    const map = new Map<number, ChannelBusinessRow>()
    for (const row of report?.rows ?? []) map.set(row.channel_id, row)
    return map
  }, [report])

  return {
    report,
    rowByChannelId,
    isLoading: query.isLoading,
  }
}
