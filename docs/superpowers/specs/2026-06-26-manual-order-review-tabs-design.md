# Manual Order Review Tabs Design

Goal: add searchable history and analysis tabs to the admin manual recharge and manual subscription review pages.

## Scope

- Recharge review keeps its current pending confirmation workflow and gains `All records` and `Analysis` tabs.
- Subscription review keeps its current pending confirmation workflow and gains `All records` and `Analysis` tabs.
- History is limited to manual orders:
  - recharge: `top_ups.payment_provider = manual_topup`
  - subscription: `subscription_orders.payment_provider = manual_subscription`
- Search supports trade number, username, email, and numeric user ID. Subscription search also supports plan title.
- Filters support status and optional create-time range.
- Analysis shows counts and money totals by status plus payment-method breakdown.

## Backend

- Add a shared manual-order query response shape with `items`, `total`, and `summary`.
- Add admin recharge endpoint under `/api/user/topup/manual`.
- Add admin subscription endpoint under `/api/subscription/admin/manual/orders`.
- Use GORM query builders and verified columns only. No schema change.
- Join user and plan display data for admin readability:
  - `top_ups` joined to `users`
  - `subscription_orders` joined to `users` and `subscription_plans`

## Frontend

- Add tabbed layout to `recharge-review` and `subscription-review`.
- Keep card layout for pending actions.
- Use compact table/list style for history so admins can scan confirmed and pending orders.
- Add filter controls above history and analysis tabs.
- Reuse small pure helpers for summary formatting and query params.

## Testing

- Backend controller tests cover manual-only filtering, status/search filters, and summary totals.
- Frontend helper tests cover status breakdown and API query construction.
- Existing pending confirmation tests remain valid.
