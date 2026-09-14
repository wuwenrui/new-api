# Read-only API-key billing metadata (v1)

## Contract owner and seam audit

**Owner:** this document and NewAPI `router/api-router.go` →
`controller.GetTokenBilling` → `service.GetTokenBillingPricing`.
This is an additive endpoint; it does not change usage, logs, relay charging,
wallet semantics, token status, or authentication policy.

**Seam verdict: ready for additive implementation**, with no business decision
needed. Producer authority is unique: existing read-only token identity comes
from `middleware/auth.go::TokenAuthReadOnly`; wallet/token records come from
`model.GetUserById` / `model.GetTokenByIds`; enabled exact models come from
`model.GetAllEnableAbilityWithChannels`; ratio authority is
`relay/helper/price.go::ModelPriceHelper` / `HandleGroupRatio` and
`service/group.go::GetUserGroupRatio`. Expressions remain owned by
`pkg/billingexpr/expr.md`, not by this endpoint or a client evaluator.

The new consumer is LawyerDesk lawyer-harness
`packages/lawyer-billing/src/newapi.js::normalizeMetadata/createNewApiClient`
(inspected in its isolated `newapi-billing` worktree). It validates version 1,
requests the selected model, and falls back on HTTP 404 to the unchanged
`/api/usage/token/` endpoint. Existing main-checkout consumers have no dependency
on this new route. Neither LawyerCopilot nor retired lawhub is changed.

## Request and response

`GET /api/usage/token/billing?model=<URL-encoded exact model name>`

Use the existing `Authorization: Bearer sk-...` read-only API-key authentication.
`model` is optional, case-sensitive and not normalized. When supplied it must
be nonempty valid UTF-8, at most 255 bytes, with no whitespace/control characters.
Duplicate model parameters, malformed URL encoding and all other query keys
(including account, token, channel and group selectors) are rejected with 400.
No client-selected account or group ID is accepted.

Successful HTTP 200 body:

```json
{
  "success": true,
  "data": {
    "version": 1,
    "observed_at": 1789380000,
    "quota_per_unit": 500000,
    "display": { "type": "USD", "exchange_rate": 1 },
    "account": { "remaining_quota": 1000000 },
    "token": { "remaining_quota": null, "used_quota": 400, "unlimited": true },
    "pricing": {
      "model": "example-model",
      "status": "available",
      "reason": null,
      "rates": [{
        "group": "default",
        "input_quota_per_token": 1,
        "output_quota_per_token": 3,
        "cache_read_quota_per_token": null,
        "cache_write_quota_per_token": null
      }]
    }
  }
}
```

All fields shown are always present. Example amounts are illustrative, not live
site prices. `observed_at` is server Unix seconds at response time, not a price
validity guarantee or an atomic database snapshot.

- `quota_per_unit`: positive finite server `common.QuotaPerUnit`, quota per USD.
  Do not hardcode a conversion factor in the consumer.
- `display.type`: `USD`, `CNY`, or `TOKENS`. USD rate is 1; CNY rate is configured
  `operation_setting.USDExchangeRate` (CNY per USD); TOKENS rate is 1 and the UI
  displays raw quota, **not an estimated number of model tokens**. CUSTOM or
  unknown server display formats normalize to canonical USD/rate 1 in v1;
  custom currency symbols/rates are not guessed or mislabeled.
- Currency amount = quota / quota_per_unit × exchange_rate. A price is already
  **quota per token**; do not divide by quota_per_unit twice.
- `account.remaining_quota`: authenticated owner's wallet quota, not this key's
  cap. `token.remaining_quota` is null only for an unlimited token; an unlimited
  token does not make the account unlimited. `token.used_quota` is key usage.
- `pricing.model`: exact requested name, or null if omitted. `rates` is always an
  array. Available means nonempty rates and null reason; unavailable means an
  empty array and stable reason. Zero is a valid free rate, not missing data.
- Each rate is ordinary text input/output quota per token, with effective
  user-group override (when present), selected token group and current peak
  multiplier. A configured cache-read ratio produces a cache-read rate;
  otherwise null. Cache-write is null in v1 because 5-minute/1-hour TTL prices
  cannot safely fit a single unqualified field.

## Authorization and conservative pricing

No model enumeration is returned. Authorization requires exact membership in
both the key's enabled model allowlist (if any) and enabled routing abilities in
eligible groups. Unknown models and forbidden models share
`model_not_authorized`. Token group defaults to the owner's current group;
explicit groups must remain usable. Auto uses existing `GetUserAutoGroup` or
`FilterUserTokenAutoGroups` semantics, preserving explicit token ordering and
restrictions (including the existing empty-list inheritance behavior). Malformed
stored Auto configuration fails closed. Auto returns all eligible group rates,
not an assumed default group. More than 100 eligible groups is unavailable,
never a truncated range.

Only explicitly recognized standard text adapters (OpenAI, Azure, Anthropic,
DeepSeek, NewAPI) currently qualify. If any eligible route has another adapter,
including custom/plugin/unknown/task pricing, the entire reference is unavailable
rather than emitting an incomplete cheap subset. Fixed per-request prices and
non-ratio modes (including expressions) are unavailable. Expressions are never
returned, parsed, compiled or evaluated. A real configured model-ratio entry is
required: the SelfUseMode fallback value is not a published price.

Stable unavailable reasons:

| Reason | Meaning |
| --- | --- |
| `model_not_requested` | Balance-only request; model is null. |
| `model_not_authorized` | Unknown model, restricted key, or no currently eligible exact routing ability. |
| `pricing_not_configured` | No actual configured model ratio. |
| `unsupported_billing_mode` | Expression/plugin/unknown billing mode, not ordinary ratios. |
| `unsupported_pricing` | Fixed per-request price or an unrecognized/ambiguous adapter. |
| `invalid_pricing` | Negative, nonfinite, or JavaScript-unsafe ratio/product. |
| `invalid_group_configuration` | Malformed Auto configuration or excessive eligible group count. |

A reference is **not a guaranteed task cap**, reservation, quote, or prediction
of the next routing decision. Context growth, retries, tool calls, extra media,
cache TTL, rounding/minimum charges, configuration changes and concurrent use
can change final billing. Client min/max is a current text-token reference only.

## Safety, errors and compatibility

The route installs `DisableCache` before `TokenAuthReadOnly`, so successful
responses and authentication rejections carry `Cache-Control: no-store`.
It uses CORS and the existing global API rate limit, without consuming the shared
critical write/login bucket; repeated balance/price reads must not prevent a manual
recharge application. Legacy usage/log route limits remain unchanged. Explicitly disabled keys and
banned users are denied; exhausted/expired keys retain read-only access exactly
as existing usage/log authentication allows. The handler rechecks owner/key and
current DB user/token status after middleware's potentially cached identity.
It does not update access time, quota, token status, usage logs or schema.

Only existing reads are used. In particular, **do not call `model.GetPricing`**:
its refresh can call `model/pricing_default.go::getOrCreateVendor` and insert a
vendor. No upstream/channel IDs, names, URLs, credentials, admin metadata,
expressions, or personal information appear in responses.

Amounts and products must be finite, nonnegative and no greater than
9007199254740991; unit and exchange rate must also be positive. Unsafe wallet,
key usage/limit or unit metadata fails with 503, `success:false`,
`code:billing_metadata_unavailable`; invalid pricing alone preserves balances
and returns unavailable pricing. Invalid request queries return 400,
`success:false`, `code:invalid_model`. Existing auth middleware preserves its
401/403/500 envelopes (do not require a new error code on those). An owner
mismatch is forbidden; no SQL errors are returned to the client.

Migration/release order: **server first**, then the LawyerDesk plugin. Old usage
and log contracts remain unchanged. With an old server, plugin HTTP 404 fallback
uses old usage/log endpoints, labels account funds unknown and estimates
unavailable, and never guesses USD conversion or account funds from token quota.
Other HTTP failures must not masquerade as an old server. Rollback either side
independently; no schema rollback, backfill, lockstep migration or production
operation is required by this implementation. Deployment is separately authorized.

## Verification

`controller/token_billing*_test.go` exercises real Gin + existing auth middleware
with disposable in-memory SQLite and fake keys only, including a write-attempt
trap, owner/auth failures, model validation/authorization, limits/unlimited,
unit formats, group overrides/Auto, expressions/fixed/unknown prices and safe
numeric boundaries. It reuses the existing isolated column-initialization
fixture, not production startup. No database query implementation, dialect,
schema, migration or dependency is changed. No claim of a live three-engine
matrix is made.

Local validation (isolated worktree, Go 1.26.5 darwin/arm64):

- `env -u SQL_DSN -u LOG_SQL_DSN -u REDIS_CONN_STRING go test ./controller ./service ./middleware ./router -count=1` — passed all four packages.
- `go build ./controller ./service ./middleware ./router` — passed.
- Cross-repository check: set `LAWYER_BILLING_CONSUMER_DIR` to the actual `lawyer-billing` package, then run `go test ./controller -run '^TestTokenBillingLawyerDeskConsumer$' -count=1 -v` — passed. The real JavaScript client performs HTTP against Gin + read-only auth + disposable SQLite, validates account/token/currency/group data and computes a reference from the real producer response. No duplicated response fixture or production connection is used; without that explicit local package path this optional integration test is skipped.
- `git diff --check` and `repo-dev.sh check` — passed. Repo-dev did not
  auto-detect Go tests; the explicit command above provides the test evidence.
- `go build ./...` — blocked by `main.go:50:12: pattern web/classic/dist: no
  matching files found` in the fresh worktree. No fake embedded files or unrelated
  frontend changes were introduced to bypass this pre-existing build prerequisite.

No production access, deployment, commit or push was performed. The live site
and packaged LawyerDesk UI were not exercised by these server tests.
