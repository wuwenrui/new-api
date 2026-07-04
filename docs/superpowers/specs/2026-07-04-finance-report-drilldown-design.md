# Finance Report Drill-down Design

## Goal

Make the admin finance report concrete and explorable: click cash income to see the
underlying top-up / subscription orders, click refund exposure to see per-user
balances, and click a user row to see where the profit from that user comes from.

## Background

The report page (`web/default/src/features/finance-report/`) currently shows five
summary cards plus model/user ranking tables backed by a single endpoint
`GET /api/finance/report` (`service/finance_report.go`). Nothing is clickable.
The refund card counts all user balances including gifted quota, while its label
claims "unused top-up balance" — verified against production data on 2026-07-04:
balance total exceeded (top-ups − consumption) by ~¥157 of non-cash quota.

## Scope

- Backend: three new read-only list endpoints under `/api/finance`, plus two new
  fields on the existing per-user report rows. No schema change.
- Frontend (web/default only): drawers for order lists, balance breakdown, and
  per-user detail; two new columns on the user ranking table; corrected card copy.
- Out of scope: model-row drill-down, classic theme, exports.

## Accounting Rules (unchanged plus additions)

- All finance queries exclude username `wuwenrui` (self-use), consistent with the
  existing report.
- Order lists filter by `complete_time` for the success view. Default status
  filter is `success`; `all` shows every status for reconciliation.
- Per-user gifted quota estimate = current balance + all-time consumption −
  all-time successful top-ups. Negative estimates clamp to 0 in display only.
- Balance figures are point-in-time snapshots, independent of the selected time
  range. The UI labels them as such.

## Backend Design

New file `service/finance_report_detail.go`, controllers in
`controller/finance_report.go`, routes under the existing `financeRoute` group
(AdminAuth):

1. `GET /api/finance/topups?start_timestamp&end_timestamp&status&username&p&size`
   Paginated top-up orders joined with username/email. `status` empty or
   `success` → success only; `all` → no status filter; other value → exact match.
2. `GET /api/finance/subscription-orders?...` — same shape over
   `subscription_orders`.
3. `GET /api/finance/balances` — one row per user with `quota > 0` or any
   successful top-up: current balance, all-time top-up sum, all-time consumption
   sum, gifted estimate. Sorted by balance desc. Computed with three grouped
   queries joined in Go (no DB-specific JSON/SQL).
4. `FinanceReportUserRow` gains `balance` and `total_topup` (snapshot,
   all-time) populated via one users query + one top-ups grouped query.

## Frontend Design

`features/finance-report/drawers/` holds three drawer components; `index.tsx`
only wires open-state:

- Cash income card → OrdersDrawer with tabs 充值订单 / 订阅订单, inheriting the
  page time range, status filter defaulting to success, paginated table
  (time, user, money, status, order id / payment fields as available).
- Refund card → BalancesDrawer: per-user balance, all-time top-up, all-time
  consumption, gifted estimate. Card hint text changes to
  「全部用户当前余额（含赠送）」.
- User ranking row click → UserDetailDrawer: balance composition numbers from
  the balances endpoint, per-model consumption via
  `GET /api/finance/report?username=X` (existing capability), and that user's
  top-up orders via the topups endpoint with `username=X`.
- User ranking table gains 余额 / 累计充值 columns (snapshot, labeled).

## Testing

- Go: unit tests in `service/finance_report_detail_test.go` covering the
  wuwenrui exclusion, time/status filters, pagination, and the gifted-estimate
  arithmetic; run alongside existing finance tests.
- Frontend: extend `finance-report-copy.test.ts` for new copy and the gifted
  estimate formatting helper.
- Manual: local binary + SQLite with seeded orders, drive drawers via browser;
  production verification after release compares drawer totals with the cards.
