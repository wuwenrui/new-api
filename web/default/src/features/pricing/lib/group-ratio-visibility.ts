function formatGroupRatio(ratio: number | undefined): string | undefined {
  if (ratio == null) return undefined
  const formatted = Number.isInteger(ratio)
    ? ratio.toString()
    : ratio.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  return `x${formatted}`
}

export function getVisibleGroupRatioSuffix(
  ratio: number | undefined,
  isAdmin: boolean
): string | undefined {
  return isAdmin ? formatGroupRatio(ratio) : undefined
}
