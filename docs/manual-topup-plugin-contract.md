# Manual recharge plugin facade (v1)

## Authority and capability decision

This additive contract is owned by NewAPI. `router/api-router.go` exposes the fixed
family below; `controller/manual_topup_quote.go` and `manual_topup_create.go` are the
shared website/plugin validation and pending-order implementation. The consumer
is LawyerDesk `packages/lawyer-billing/src/manual-topup.js`, with account-bound
confirmation handles in `src/manual-host.js` and a native plugin panel.

This is an explicit **new model-key capability to apply for manual recharge**, not
read-only billing access and not credit authority. Every route uses
`TokenAuthReadOnly` only for initial identity parsing, followed by
`TokenManualTopUpAuth`: current DB key/owner equality, soft deletion, status,
expiry and key IP restrictions are checked on every request without relying on
cached validity. Enabled and exhausted keys may apply with no remaining key cap
or wallet funds. Disabled/revoked/deleted/rotated keys, expired keys (including an
expired timestamp on an otherwise enabled key), and banned/deleted owners cannot.
Global UserAuth and TokenAuthReadOnly policies remain unchanged. No user tokens
are minted and no administrator operations are exposed.

All routes are no-store and inherit API CORS/global limiting. Only POST orders
uses CriticalRateLimit plus ManualTopUpWriteRateLimit, an owner-keyed bucket using
the existing UserCriticalRateLimit infrastructure/configuration. Changing IP or
model key does not reset the owner bucket. Like site critical limiting, these
buckets honor CriticalRateLimitEnable and its configured maximum/duration. Reads
and quote do not consume either critical bucket.

## Fixed HTTP contract

Base: `/api/billing/token/manual-topup`; authenticate with
`Authorization: Bearer sk-<current model key>`.
All successful responses use HTTP 200 `{ "success": true, "data": ... }`.
No selectors for user, key, group, channel, QR URL or status are accepted.

### GET /options

No query parameters. Data:

```json
{"version":1,"enabled":true,"min_amount":1,"amount_step":1,"amount_options":[1,10],"payment_currency":"CNY","methods":[{"id":"manual_wechat","name":"微信人工充值"},{"id":"manual_alipay","name":"支付宝人工充值"}],"instructions":"Site-configured instructions"}
```

Values above are illustrative, not price constants. Availability/methods derive
from the same site compliance confirmation, manual enabled switch and configured
QR methods as the website. Disabled payment returns enabled:false and methods:[].
QR data is not returned until an order exists. Minimum follows the site's manual
minimum (nonpositive unset minimum defaults to one stored unit). Presets derive
from the site's AmountOptions, filtered to representable request quantities at
or above the minimum; an empty preset array is valid.

USD, CNY and CUSTOM display modes have step 1; custom display labels do not change
the existing stored recharge quantity or CNY collection price. TOKENS requires a positive integral
QuotaPerUnit and uses that value as step: only whole stored-unit multiples can
be submitted, never a quantity that would silently truncate stored credit.
Unsupported display modes, nonfinite/nonpositive price or quota units, unsafe
minimum and nonintegral TOKENS unit fail closed (options HTTP 503). No custom
currency is guessed.

### POST /quote

JSON body exactly `{ "amount": 10, "payment_method": "manual_wechat" }`.
Both fields required, amount integral; duplicate/unknown fields, null, trailing
JSON, oversized bodies (>1024 bytes) and query parameters are rejected.

Data: `{ "amount": 10, "payment_method": "manual_wechat", "money": 20,
"payment_currency": "CNY", "expected_quota": 5000000 }` (illustrative).

Label amount **recharge quantity**, and separately label money **CNY payable**.
Request units are not naively CNY. Authoritative money is shared `getPayMoney`
using the current owner's recharge group, site Price and configured amount
Discount; finite nonpositive discount values remain unused, as in the existing
site calculation. It is **not USDExchangeRate** and does not use the key's routing group.
Expected quota uses shared validateTopUpQuota/getTopUpQuota/storage semantics
and current wallet-capacity validation. Finite positive payment >=0.01 and
JavaScript-safe quota/payment bounds are required. Quote is informational, not
reserved pricing; create repeats validation against current settings.

### POST /orders

Identical strict input. Data has exactly the existing website manual receipt:
`trade_no`, `amount` (stored quantity), `display_amount` (request quantity),
`money`, `payment_method`, `payment_name`, `qr_url`, `instructions`.

Both website RequestManualTopUp and this facade call `createManualTopUp`, which
uses the shared quote validator, inserts one pending manual TopUp and invokes
the existing asynchronous NotifyRechargePending plus existing fallback once.
Bark receives the actual `/recharge-review?trade_no=...` admin deep link. Creating
an order neither credits wallet nor changes model-key quota/usage/status.
Website success remains `{ "message": "success", "data": ... }` and existing
error envelope is preserved. Website now also rejects unsafe quantities,
nonfinite/invalid configuration and TOKENS truncation explicitly.

There is **no durable request key or idempotency guarantee**. Do not auto-retry.
On an ambiguous timeout refresh history before an explicit user-controlled
retry. A notification can fail after the order is persisted; the receipt/history,
not a notification acknowledgement, is the order authority.

### GET /orders?p=1&page_size=20

Defaults 1/20; p is 1..1000000 and page_size is 1..100. Unknown/duplicate keys,
malformed encoding and nonpositive/noninteger/out-of-bounds values return 400.
Data: `page`, `page_size`, `total`, `items` (always an array). Every item contains
only `trade_no`, `money`, `payment_method`, `status`, `create_time`, `complete_time`.
Times are Unix seconds. Empty history has items:[] and total:0.

`model.GetUserManualTopUpHistory` filters DB owner and manual_topup provider
**before count and pagination**, with the same `topUpQueryCutoff()` last-30-days
lower bound as the website, newest database order first. No personal details,
internal owner IDs, quota or channel data are exposed.

## Settlement and wallet display

Existing administrator completion is the only crediting path. Its ignored GORM
v1 query-option was replaced by shared `lockForUpdate(tx)`: MySQL/PostgreSQL row
locking, SQLite-compatible omission. No schema/ledger or admin workflow rewrite.
Existing idempotent completion rechecks pending status and wallet capacity.

The separate existing admin confirm-status action can mark success **without
crediting the wallet**. Therefore display success as **processed**, never promise
all successful orders were credited. Show the real account wallet separately
from order status and from model-key remaining cap using read-only billing
metadata; refresh wallet independently after review.

Validation failures return HTTP 400 success:false/message; options configuration
failures return 503; insert storage failures return a generic 503 (potentially
ambiguous outcome, not definite validation rejection); history storage failures return a generic 500. Existing
initial auth envelopes/statuses are retained; dedicated auth uses 401/403/500.
No database errors or credentials are returned.

## Compatibility and rollout

Seam review: ready based on the current website manual handler/helper chain,
service/recharge_notify.go, model/topup.go and the constrained model-key capability documented above.
This contract is additive, not a change to existing usage/read-only metadata.
Deploy **server first**, then plugin. Old servers return 404: disable manual
application rather than substituting UserAuth or assuming payment configuration.
Old website clients keep their response shape. Rollback either side independently;
no database migration, backfill or cross-repository atomic deployment required.
Deployment, real orders, external Bark and production access are not authorized.

## Verification

Local tests use real Gin handlers and disposable SQLite, with Redis disabled and
SQL_DSN/LOG_SQL_DSN/REDIS_CONN_STRING unset for aggregate verification. Fake Bark
is loopback only.

Passed locally:

- `env -u SQL_DSN -u LOG_SQL_DSN -u REDIS_CONN_STRING go test ./controller ./service ./middleware ./router ./model -count=1` — all five complete package suites passed, including preserved read-only token billing regressions.
- `env -u SQL_DSN -u LOG_SQL_DSN -u REDIS_CONN_STRING go build ./controller ./service ./middleware ./router ./model` — passed.
- Final focused `go test ./controller -run 'Test(TokenManualTopUp|GetManualTopUpMinTopupUsesDisplayType)' -count=1` with the same environment exclusions — passed after adding successful TOKENS creation/storage and once-only settlement coverage.
- `git diff --check` and `repo-dev.sh check` — passed. Repo-dev does not automatically detect Go tests; the explicit suites above provide the evidence.

New controller tests exercise strict input, CNY payable with actual group/discount
settings, supported currencies, unsafe settings and wallet capacity, exact pending
order creation with unchanged wallet/token, local fake Bark called once with the
real review link, website envelope compatibility, existing administrator handler
completion twice with one credit, and status-only success with no credit. History
and middleware tests cover owner/provider isolation before pagination/count,
exhaustion, expiry, current-state revocation/rotation, IP restrictions and separate
owner throttling. Router tests verify authentication on every facade route and
absence of the forbidden write families.

Three-dialect lock tests inspect actual settlement-query GORM locking plus the
existing lock helper tests; these are not live MySQL/PostgreSQL integration tests.
Website session and admin authentication are unchanged and not reimplemented in
the handler fixtures. The optional cross-repository JavaScript consumer test
requires LAWYER_BILLING_CONSUMER_DIR and is skipped when unset. It was explicitly
executed against the actual plugin: both read-only and manual consumers passed.
`controller/token_manual_topup_consumer_test.go` verifies actual consumer options,
quote, both methods, owner-filtered history and independently refreshed wallet
through real Gin/SQLite and existing admin completion/status-only handlers.
UI evidence is recorded in the LawyerDesk product acceptance document.

Root `go build ./...` retains the known fresh-worktree prerequisite failure:
missing `web/classic/dist` embedded assets. No fake assets were created. No
production access, real orders, real Bark, deployment, commit or push occurred.
