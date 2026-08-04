# Official Model Price Sync Design

## Goal

When a channel does not expose `/api/pricing`, the admin price-comparison page can resolve official token prices from the same Models.dev catalog used by Sub2API onboarding, preview every context tier, and apply a target gross margin without manual price entry.

## Current failure

- The `1x-sub-openai` and `1x-sub-grok` channels expose model lists but no pricing endpoint or channel purchase-price settings.
- GPT-5.6 models use `tiered_expr` billing and are excluded from the comparison report because the report currently requires ratio or fixed pricing.
- The existing sync endpoint only writes ratio maps and deliberately rejects tiered-expression models.
- A scalar purchase price cannot represent the 272K GPT and 200K Grok context thresholds.

## Price authority

- OpenAI prices come from `https://developers.openai.com/api/docs/pricing`.
- xAI prices come from `https://docs.x.ai/developers/pricing`.
- Runtime catalog data is loaded through `@opencode-ai/models`, matching the existing Sub2API onboarding implementation. Models.dev is the normalized transport; canonical provider entries (`openai`, `xai`, and other first-party providers) are selected, never the cheapest reseller duplicate.
- Catalog fallback is used only when neither a live upstream price nor a manually maintained purchase price exists.

## Data model

`ChannelModelPrice` keeps its base input/output/cache prices and adds:

- `source`: `models_dev` for official catalog records.
- `provider`: canonical Models.dev provider ID.
- `tiers`: ordered records containing `name`, `context_threshold`, and all token prices.

This remains inside the existing channel `other` JSON; no database migration is required.

## Sync behavior

1. The dialog prefers live detected cost, then maintained channel cost, then canonical Models.dev cost.
2. For official pricing, selling price is calculated independently for every price dimension as `cost / (1 - margin)`.
3. The existing `buildModelsDevBillingExpression` generator creates one `tiered_expr` expression covering base, long-context, cache-read, and cache-write prices.
4. One backend request transactionally writes the channel purchase-price record and the global billing maps.
5. Tiered sync sets `billing_setting.billing_mode[model] = "tiered_expr"`, writes the expression, and removes conflicting entries from `ModelRatio`, `CompletionRatio`, `CacheRatio`, `CreateCacheRatio`, and `ModelPrice`.
6. Ratio sync remains unchanged for channels with scalar live or maintained prices.

## Comparison report

- Models with a valid `tiered_expr` are included.
- Base and tier-local selling prices are evaluated from the billing expression using the existing expression engine.
- Official purchase tiers and calculated selling tiers are returned to the UI.
- Historical cost aggregation uses each consume log's `matched_tier`; older logs without a tier use the base price.
- The UI labels the official source and displays context thresholds rather than hiding tiered pricing behind a single base value.

## Safety

- Official expressions are smoke-tested before persistence.
- Channel ID, model membership, provider, thresholds, and all prices are validated as finite and non-negative.
- Options and channel settings commit in one database transaction; compare-and-swap retries preserve concurrent pricing edits.
- The existing management audit records the model, channel, provider, source, and changed option keys.
- No production data is changed until code is merged, CI publishes `origin/main`, and the deployed endpoint is exercised with an authenticated no-op read followed by the four explicitly reviewed model updates.
