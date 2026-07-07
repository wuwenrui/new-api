import type { PricingChannel } from '../types'

export function buildPricingChannelLabels(
  channels: readonly PricingChannel[] | undefined
): string[] {
  return (channels ?? []).map((channel) => {
    const name = channel.name.trim()
    return name ? `${name} #${channel.id}` : `#${channel.id}`
  })
}
