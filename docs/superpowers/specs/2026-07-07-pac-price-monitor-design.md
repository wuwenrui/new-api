# PAC Price Monitor Design

## Goal

Build an internal new-api feature that monitors PAC upstream prices daily, compares them with local model pricing, reports gross margin risks, and exposes the same data in the admin finance page.

## Scope

- Monitor enabled PAC channels whose `base_url` points to Packy and whose models are locally served.
- Fetch upstream prices from Packy's `/api/pricing`.
- Compare upstream model ratio, upstream group ratio, completion ratio, local model ratio, local group ratio, and resulting gross margin.
- Send a daily admin notification even when prices are unchanged, with a short healthy summary.
- Add a finance page section for live price comparison, price change status, per-model usage, revenue, estimated cost, and gross profit over a selected time range.

## Architecture

The feature lives inside new-api instead of an external cron script. A scheduled `system_task` runs once per day, fetches Packy pricing, computes a comparison snapshot, stores the result in the task history, and sends notifications through the existing admin notification pipeline. The finance page calls a new admin API endpoint that uses the same comparison service plus existing usage logs to render current pricing and interval profit.

## Data Sources

- Local channels: `channels` and `abilities`, filtered by enabled PAC Packy channels.
- Local prices: `ModelRatio`, `CompletionRatio`, `CacheRatio`, and `GroupRatio` from ratio settings.
- Upstream prices: Packy `/api/pricing`, using `model_ratio`, `completion_ratio`, and `group_ratio`.
- Usage and revenue: existing consume logs, with model, channel, quota, prompt tokens, completion tokens, and timestamp filters.

## Upstream Mapping

PAC channel-to-upstream group is inferred conservatively:

- Prefer an explicit mapping stored in channel settings when present.
- Fall back to known PAC channel names already used in production, such as `pac-hunyuan`, `pac-gemini`, and `pac-gpt`.
- If no mapping is known, include the model row with `status=unmapped` instead of guessing a cost.

## Gross Margin Rules

- Local input price per 1M tokens: `local_model_ratio * local_group_ratio * 2`.
- Local output price per 1M tokens: local input price multiplied by local completion ratio.
- Upstream input price per 1M tokens: `upstream_model_ratio * upstream_group_ratio * 2`.
- Upstream output price per 1M tokens: upstream input price multiplied by upstream completion ratio.
- Gross margin: `(local_input_price - upstream_input_price) / local_input_price`.
- Default target margin: 60%.
- Rows below target are `risk`; changed upstream prices are `changed`; missing mapping/prices are `unknown`.

## Notification

The scheduled task sends one daily notification to admin users who enabled upstream model update notifications. The message includes:

- whether upstream prices changed;
- number of checked models;
- number of risk rows below target margin;
- number of unknown/unmapped rows;
- yesterday revenue, estimated upstream cost, gross profit, and gross margin;
- top risk examples, capped to keep messages readable.

## Admin UI

Extend the existing finance report page with a price monitor section:

- summary cards: checked models, changed prices, risk rows, interval gross profit;
- table: channel, model, upstream group, local price, upstream price, gross margin, usage, revenue, cost, profit;
- filters reuse the existing finance date range;
- no secrets or channel keys are returned to the browser.

## Error Handling

- If Packy pricing cannot be fetched, the task fails and sends a failure notification with no secret values.
- If some rows cannot be mapped, the task succeeds with `unknown` rows and includes them in the warning count.
- If usage logs are missing optional token fields, financial totals still use quota-based revenue and available token counts.

## Testing

- Backend unit tests cover Packy pricing parsing, channel mapping, margin calculation, notification summary, and interval usage aggregation.
- Backend route tests verify admin-only access and response shape.
- Frontend tests cover query building and status copy for healthy, changed, risk, and unknown rows.
- Verification commands: `go test ./...` in `new-api`, plus targeted `bun` tests/typecheck in `new-api/web/default`.

## Rollout

Ship disabled only by environment if needed, but default enabled for production with a 24-hour interval. The first run sends a baseline notification; subsequent runs compare against the latest previous successful snapshot.
