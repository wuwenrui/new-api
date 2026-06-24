import z from 'zod'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'
import { ROLE } from '@/lib/roles'
import { SubscriptionReview } from '@/features/subscription-review'

const subscriptionReviewSearchSchema = z.object({
  trade_no: z.string().optional().catch(undefined),
})

function SubscriptionReviewRoute() {
  const { trade_no } = Route.useSearch()
  return <SubscriptionReview tradeNo={trade_no} />
}

export const Route = createFileRoute('/_authenticated/subscription-review/')({
  beforeLoad: () => {
    const { auth } = useAuthStore.getState()
    if (!auth.user || auth.user.role < ROLE.ADMIN) {
      throw redirect({ to: '/403' })
    }
  },
  validateSearch: subscriptionReviewSearchSchema,
  component: SubscriptionReviewRoute,
})
