import { ROLE } from '@/lib/roles'

type RatioSource = {
  group_ratio?: number
  user_group_ratio?: number
}

export function canViewInternalBillingDetails(role?: number | null): boolean {
  return (role ?? ROLE.GUEST) >= ROLE.ADMIN
}

function formatRatioCompact(ratio: number | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '-'
  return ratio % 1 === 0
    ? String(ratio)
    : ratio.toFixed(4).replace(/\.?0+$/, '')
}

export function getVisibleGroupRatioText(
  other: RatioSource | null,
  canViewInternalBilling: boolean
): string | null {
  if (!canViewInternalBilling) return null

  const userGroupRatio = other?.user_group_ratio
  if (
    userGroupRatio != null &&
    userGroupRatio !== -1 &&
    Number.isFinite(userGroupRatio)
  ) {
    return `${formatRatioCompact(userGroupRatio)}x`
  }

  const groupRatio = other?.group_ratio
  if (groupRatio != null && groupRatio !== 1 && Number.isFinite(groupRatio)) {
    return `${formatRatioCompact(groupRatio)}x`
  }

  return null
}
