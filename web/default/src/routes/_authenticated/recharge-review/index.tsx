import z from 'zod'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'
import { ROLE } from '@/lib/roles'
import { RechargeReview } from '@/features/recharge-review'

const rechargeReviewSearchSchema = z.object({
  trade_no: z.string().optional().catch(undefined),
})

function RechargeReviewRoute() {
  const { trade_no } = Route.useSearch()
  return <RechargeReview tradeNo={trade_no} />
}

export const Route = createFileRoute('/_authenticated/recharge-review/')({
  beforeLoad: () => {
    const { auth } = useAuthStore.getState()
    if (!auth.user || auth.user.role < ROLE.ADMIN) {
      throw redirect({ to: '/403' })
    }
  },
  validateSearch: rechargeReviewSearchSchema,
  component: RechargeReviewRoute,
})
