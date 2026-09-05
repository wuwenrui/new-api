# Channel selling prices implementation plan

> Execute in the isolated `task/channel-sale-margin` worktree; the user approved the design and implementation in this task.

**Goal:** Detect unpriced channel models and maintain their four token selling prices from a target gross margin beneath purchase prices.

**Architecture:** Reuse the model-specific system options reader (including canonical pricing keys and locked completion metadata) and single-model pricing writer. A pure calculation module resolves pricing state, validates margin/price drafts, and converts USD prices into existing ratios. A separate form-connected panel owns queries, drafts and explicit saving. No database or billing contract changes.

**Tech stack:** React, React Hook Form, React Query, TypeScript, Vitest/Testing Library, existing pricing APIs.

## Constraints and accepted design

- USD per million tokens; margin = (sale - purchase) / sale; sale = purchase / (1 - margin / 100).
- Distinguish missing, ratio (including explicit zero/free), per-request, tiered and incomplete pricing. Failed reads must never become missing-price notices.
- Live calculations use unsaved purchase inputs. Prices are saved separately and globally by site model name; explain same-name channel impact and selected user-group ratio.
- Bulk suggestions affect missing models only. Zero costs are valid, but missing costs are never assumed zero. Invalid/non-finite inputs and margin >= 100 cannot save.
- Preserve fixed and tiered billing; route those to existing pricing management. Honor locked completion ratios, report unsupported proposals instead of silently changing amounts.
- Fetch again before saving, reject drift, verify after saving. Successful rows clear their drafts; failures retain drafts. Never auto-retry uncertain writes.
- New model selection is reflected before channel save. Model pricing can be saved independently of channel membership. Removing a model excludes its draft from saving.
- No production configuration writes or deployment as part of local verification.

## Task 1 — Pricing state and math

Files: `web/default/src/features/channels/lib/channel-sale-pricing.ts` and `.test.ts`.

- [x] Add failing tests for missing/free/fixed/tiered resolution, canonical keys, group conversion, locked completion, margin validation and zero costs.
- [x] Run `bun run test src/features/channels/lib/channel-sale-pricing.test.ts` and confirm red.
- [x] Implement typed snapshots and draft helpers. Core assertions: `saleFromMargin({input:2.5,output:12.5,cache_read:0.25,cache_write:3.125},20).input === 3.125`; `model_ratio = input / (2 * groupRatio)`; the other ratios divide by input.
- [x] Re-run tests until green.

## Task 2 — Form panel and safe persistence

Files: `components/channel-selling-prices.tsx`, `components/channel-selling-price-row.tsx`, `hooks/use-channel-selling-prices.ts`, `lib/channel-sale-save.ts`, associated interaction/save tests. Integrate by rendering the panel after the purchase fields in `channel-model-pricing-fields.tsx`.

- [x] Add failing interaction and persistence tests: model added, draft changes, group switch, missing-cost refusal, bulk missing-only, failed/partial saves, drift and successful readback.
- [x] Implement automatic status summary, group selection, margin and sale fields with per-category cost/current/proposal/margin, explicit save action and global impact notice.
- [x] Reuse `getSystemOptionsForModel` and `updatePricingOptions`. Cache individual model snapshots; disable save while an operation is pending or invalid.
- [x] Add English and Chinese translations; all other locales keep explicit English fallback text.
- [x] Run the scoped test suites and related pricing regression suites.

## Task 3 — Verification and review

- [x] Run typecheck, changed-file lint and format checks, production frontend build.
- [x] Review actual field/request path, same-name pricing scope, error retention, keyboard labels and responsive overflow. Fix findings and run affected tests again.
- [x] Record evidence and implementation limitations, commit the completed feature on the isolated task branch.

## Implementation and verification notes

- Root-only panel mirrors existing `/api/option/` access control. Ordinary channel editors do not issue unauthorized option queries.
- Existing per-request and tiered pricing are recognized and link to the existing model pricing editor; this flat token-price calculator does not rewrite their billing rules.
- Original model names resolve cache prices, while canonical server-supplied keys resolve shared input/output pricing. Saving refreshes other visible models sharing that key.
- Failed drafts retain values; explicit recalculation after refreshing an online conflict captures the refreshed baseline.
- Independent review completed; all four findings corrected with regressions.
- Browser verification used local simulated data: missing-model detection, 20% margin proposal, save/readback, and desktop/narrow layout. No live production prices were written.

### Final evidence

- `bun run test src/features/channels/lib src/features/channels/components/channel-selling-prices.test.tsx src/features/channel-price-compare`: 15 files, 158 tests passed.
- `bun run typecheck`: passed. Changed-file oxlint and protected-header-aware oxfmt checks: passed.
- `bun run build`: passed, final build 28.8 seconds.
- `repo-dev.sh check`: passed; root auto-detection did not find frontend tests, so the explicit commands above are the test evidence. Test file 341 lines hits only the script’s 300-line soft advisory.
- Production deployment is outside this implementation run.
