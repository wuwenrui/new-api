# 售价同步最终审查修复报告

日期：2026-08-14

状态：实现与任务门禁通过；完整宽范围 race 仍会命中本次变更之外的 logger.logCount 既有竞态，定价路径定向 race 全部通过。

提交号：本报告所在的最终提交；Git 提交无法在自身受版本控制的内容中记录其最终哈希，实际 SHA 以交付回复中的提交号为准。

## 修复结论

| 要求 | 结果 | 关键实现与回归 |
| --- | --- | --- |
| Models.dev 来源端到端保留 | 通过 | service/channel_price_compare.go；service/channel_price_compare_test.go；types.ts；price-sync-dialog-regression.test.tsx |
| 运行时定价快照同代发布与读取 | 通过 | setting/ratio_setting/pricing_snapshot.go；model/option.go；relay/helper/price.go；controller/ratio_sync.go |
| 旧请求按事务内 DB 真值校验 | 通过 | controller/option.go；controller/option_pricing_test.go |
| 官方价格必须有显式标记 | 通过 | price-sync.ts；price-sync.test.ts；price-sync-dialog-regression.test.tsx |
| 四类弹窗错误互斥且独立 | 通过 | price-sync-dialog.tsx；price-sync-dialog-regression.test.tsx |
| fr/ja/ru/vi/zh-TW 文案完成 | 通过 | 7 个 locale 文件仅修改任务键，delta 一致性 7/7 |

## 根因与修复

### 1. 持久化 Models.dev 来源被降成 manual

根因：渠道经营对比响应只识别缺失/人工分支，已持久化的 model_prices.source=models_dev 没有被映射回官方来源。前端类型也不接受 models_dev，重开弹窗后因此走普通倍率请求并可能删除官方分档。

修复：

- service/channel_price_compare.go 保留 models_dev 来源，并从同一个 ModelPricingSnapshot 生成计费模式、表达式和各倍率。
- web/default/src/features/channel-price-compare/types.ts 扩展 price_source 联合类型。
- web/default/src/features/channel-price-compare/lib/price-sync.ts 仅在无人工/探测基准且 uses_official_pricing===true 时启用官方路径。
- 回归覆盖“官方价格持久化后重开”，断言仍提交 billing_mode=tiered_expr、purchase_price_source=models_dev 和原分档 tiers。

### 2. relay 可能混读不同代定价配置

根因：倍率/固定价与 billing mode/expression 原先从不同受保护区域分次读取；多键事务提交后又逐项发布运行时配置。读者可能组合新倍率与旧表达式，且 map 复制不在一个统一读锁内。

修复：

- setting/ratio_setting/pricing_snapshot.go 将模型倍率、补全/缓存倍率、固定价、计费模式和表达式放入一个不可变快照，并以 generation 标识发布代次。
- WritePricingSnapshot 持有统一写锁；成功的多键发布只递增一次 generation，失败写入不递增。
- model/option.go 的启动加载、单项更新和批量事务提交统一经该写锁发布；普通 option 行为不变。
- relay/helper/price.go 的倍率、固定价、mode 和 expression 均来自同一个快照。
- controller/ratio_sync.go 的运行时同步数据也从同一快照复制，避免单独读取 billing map。
- 锁顺序核对：外层 pricing snapshot 锁覆盖各配置加载/复制；配置实现不反向获取 snapshot 锁。定向死锁屏障、40 轮并发发布/读取和 race 均通过。

### 3. 旧请求校验依赖进程缓存而非事务 DB 真值

根因：省略 billing_mode 的旧倍率请求在事务开始前通过进程缓存判断模型是否为 tiered。DB 与缓存不一致时会错误允许或拒绝。

修复：

- controller/option.go 保留无状态请求校验在事务前执行。
- 与当前计费模式有关的规则移入事务 builder，从 current["billing_setting.billing_mode"] 解析 DB 当前值。
- 领域拒绝通过 sentinel 映射为 HTTP 400，不降低原保护。
- 双向集成测试：
  - DB=tiered、cache=ratio：省略 mode 必须拒绝。
  - DB=ratio、cache=tiered：合法旧倍率请求必须允许。

### 4. 缺失官方标记被错误推断为官方

根因：前端将 uses_official_pricing 未定义的旧数据推断为官方价格，和已批准的“显式官方标记”设计冲突。

修复：

- shouldUseOfficialPricing 先排除人工/探测基准，然后只接受 uses_official_pricing===true。
- 单元测试覆盖 undefined/false/true 三类标记；组件测试覆盖缺失标记时保持“缺采购价”，不请求官方价格。

### 5. 弹窗错误状态共用一个兜底

根因：缺采购价、官方加载失败、输入非法与有限输入计算溢出最终都落到“无 plan”，用户无法判断该补数据、重试还是修改输入。

修复：

- price-sync-dialog.tsx 将四类状态按前置条件互斥计算：
  - 缺少完整采购价；
  - 官方价格加载失败；
  - 负数/NaN/无穷等非法输入；
  - 有限非负输入造成售价计算溢出。
- mutation 抛出的本地化错误与界面提示保持同一分类。
- 保留目标成本利润率标签、帮助文案及毛利率预览；未放宽负数约束。

### 6. locale 仍有英文回退

修复：

- fr/ja/ru/vi/zh-TW 翻译以下既有财务文案：
  - Target cost profit rate (profit ÷ cost)
  - 100% means the selling price is 2× cost; 455.56% means about 5.56× cost.
  - Cost profit rate must be at least 0
- 7 个 locale 增加三类新错误文案：
  - Complete purchase price is required before syncing
  - Maintain complete input, output, cache read, and cache write purchase prices before syncing.
  - Selling price calculation overflowed
- 未运行会重写既有翻译的全量 i18n:sync；使用 HEAD delta 校验，确认仅任务键发生变化。

## TDD 证据

### RED

后端来源与 DB 真值：

~~~text
go test ./service ./controller -run 'TestBuildChannelPriceCompareRowPreservesModelsDevPurchaseSource|TestUpdatePricingOptionsUsesDatabase(Tiered|Ratio)Mode' -count=1
~~~

结果：3 个新增场景失败。Models.dev 实际返回 manual；DB=tiered/cache=ratio 实际 200；DB=ratio/cache=tiered 实际 400。

统一快照：

~~~text
go test ./setting/ratio_setting -run TestModelPricingSnapshotPublishesBillingConfigurationWithRatios -count=1
~~~

结果：编译失败，快照缺少 Generation、BillingMode、BillingExpr、BillingExprFound。

运行时同步读取：

~~~text
go test ./setting/ratio_setting -run TestRuntimePricingSyncDataUsesTheBillingSnapshot -count=1
~~~

结果：编译失败，统一运行时同步 getter 尚不存在。

前端：

~~~text
bun test src/features/channel-price-compare/lib/price-sync.test.ts
bun run typecheck
bun test src/features/channel-price-compare/components/__tests__/price-sync-dialog.test.tsx
~~~

结果：纯逻辑 47 通过/2 失败；类型检查因 models_dev 不在联合类型报 TS2322；组件 5 通过/4 失败。

### GREEN

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 全仓 Go | go test -json ./... -count=1 | 1324 tests / 35 packages 通过，0 失败 |
| 定价路径 race | go test -race ./setting/ratio_setting ./model ./relay/helper ./service ./controller -run 'Test(...)' -count=1 | 5/5 packages 通过 |
| 前端单元+交互 | bun test price-sync.test.ts price-sync-dialog.test.tsx price-sync-dialog-regression.test.tsx | 58/58 通过 |
| TypeScript | bun run typecheck | 通过 |
| 生产构建 | bun run build:check | Rsbuild 通过 |
| changed-file lint | bunx oxlint <5 个任务 TS/TSX 文件> | 通过 |
| changed-file format | bunx oxfmt --check <5 个任务 TS/TSX + 7 locale 文件> | 通过 |
| Go 格式 | gofmt -l <11 个任务 Go 文件> | 无输出 |
| diff 健康 | git diff --check | 通过 |
| locale 范围 | HEAD delta consistency | 7/7 locale 仅允许键变化 |
| 独立审查 | Critical/Important/Minor 对账 | PASS，无修复缺口 |

定向 race 覆盖以下关键行为：统一快照字段、运行时同步 getter、失败写不增代、单项/批量/启动加载发布代次、40 轮并发无混代、锁屏障、tiered 表达式一致读取、relay tiered 定价、Models.dev 来源、DB 真值双向校验、控制器运行时同步。

## 覆盖率

后端命令：

~~~text
go test ./controller ./service ./setting/ratio_setting ./model ./relay/helper -coverprofile=/tmp/final-review-fixes.cover.out -count=1
~~~

- 本次变更 Go 可执行行：57/62，91.9%。
- 核心函数：事务 builder 91.7%，更新端点 93.5%，渠道对比行 83.8%，分档 helper 82.8%，快照写入/模型发布/运行时同步 100%。
- 包整体 25.6% 是仓库既有基线，不代表本次 diff 覆盖率。

前端命令：

~~~text
bun test --coverage src/features/channel-price-compare/lib/price-sync.test.ts src/features/channel-price-compare/components/__tests__/price-sync-dialog.test.tsx src/features/channel-price-compare/components/__tests__/price-sync-dialog-regression.test.tsx
~~~

- price-sync.ts：函数 100%，行 98.60%。
- price-sync-dialog.tsx：函数 88.89%，行 92.74%。
- 58/58 测试通过。

## 新增或扩展的测试

- service/channel_price_compare_test.go：持久化 Models.dev 来源保留。
- controller/option_pricing_test.go：DB/cache 双向不一致、运行时同步快照。
- setting/ratio_setting/pricing_snapshot_test.go：billing 配置与倍率同代、屏障与失败发布。
- model/option_sync_test.go：单项/多键/启动发布代次、并发读者无混代。
- relay/helper/price_test.go：tiered mode/expression 与倍率同快照。
- web/default/src/features/channel-price-compare/lib/price-sync.test.ts：显式官方 marker 与 models_dev 类型路由。
- web/default/src/features/channel-price-compare/components/__tests__/price-sync-dialog-regression.test.tsx：持久化重开、缺采购价、官方失败、非法输入和溢出。

## 数据库与兼容性

- 无 schema/DDL、迁移或生产写入。
- 仅复用现有 options 事务与 JSON 配置；不新增数据库方言相关 SQL，SQLite/MySQL/PostgreSQL 兼容面未改变。
- 不修改渠道倍率、路由、历史财务数据或生产采购价。

## 剩余风险

1. 宽范围 go test -race ./controller ./service ./setting/ratio_setting ./model ./relay/helper -count=1 会在未改动的 logger/logger.go 全局 logCount 命中既有竞态；定价相关测试的 -race 5/5 包已通过。本次未越权修改日志子系统。
2. 严格按 en 全键集对比时，zh.json 存在 38 个既有额外键；本次 HEAD delta 7/7 仅包含任务键，没有扩大基线差异。
3. PriceSyncDialog 及少数既有纯函数早已超过 50 行；本次没有新增超过 50 行的生产函数，也未进行与审查缺陷无关的重构。

## 二次最终复审追加（2026-08-14）

### 追加修复结论

| 复审项 | 根因 | 修复与证据 |
| --- | --- | --- |
| 强制重建越过运行时定价发布 | model.RefreshPricing 原先持有重建与 endpoint 锁后直接读取分散配置，没有进入统一 pricing snapshot 读锁；批量 option 已提交 DB、但运行时 map 尚未发布完整时，重建可能混读两代并与无独立锁的 billing map 竞态 | model/pricing_refresh.go 保留 `updatePricingLock -> modelSupportEndpointsLock` 顺序，并在最内层通过 `ReadPricingSnapshot(updatePricing)` 重建。controller/model_meta.go 的模型新建、更新、删除真实入口均复用该函数。model/pricing_refresh_snapshot_test.go 以真实 UpdateOptionsBulk、DB 持久化观测和 OptionMap 发布屏障证明：发布未完成时强制刷新不能越过，释放后无死锁，结果仅包含完整新代固定价、tiered mode 与表达式。writer 在释放 snapshot 后才通知缓存失效，因此没有 snapshot 到重建锁的反向持锁。 |
| 官方源无效与算术溢出混为一类 | 旧计划函数用同一个 null 表示畸形 Models.dev 数据和有限有效数据运算溢出；零 input、非法 tier 会误报 overflow | web/default/src/features/channel-price-compare/lib/price-sync.ts 引入判别结果 `ready / invalid-input / invalid-source / overflow`：非正 input、非有限或负成本、非法 tier threshold、无效 upstream multiplier 均归 invalid-source；只有有限有效源与有限非负成本利润率在售价、分档或表达式系数计算中变成非有限值才归 overflow。price-sync-dialog.tsx 按判别结果保持“缺采购价 / 官方不可用 / 成本利润率非法 / 溢出”四态互斥。兼容 wrapper 仍保留 plan/null 契约。 |
| 表达式内部系数仍可出现 Infinity | 首轮判别只检查展示售价；极小 groupRatio 或超大 audio 成本可在 `value * upstream * scale / divisor`、以及 formatter 的 `coefficient * 1e9` 中溢出，但表达式字符串仍非空并误返 ready | price-sync.ts 在构造表达式前镜像校验 base 与全部 tiers 的 input/output/cache read/cache write/input audio/output audio 系数及 formatter 运算；新增 tiny group ratio 与 audio overflow 回归。独立复审确认全部新增生产函数不超过 50 行，最长分类入口 48 行。 |
| 五个 locale 的官方失败文案仍为英文 | fr/ja/ru/vi/zh-TW 缺少两条官方价格不可用真翻译 | 五个 locale 各仅新增 `Official model price could not be loaded` 与 `Official pricing is unavailable for this model and provider.` 两个翻译值；HEAD delta 校验 7/7 locale、2/2 键通过。 |

### 二次 TDD 证据

RED：

~~~text
go test ./model -run '^TestRefreshPricingWaitsForRuntimePricingPublication$' -count=1
~~~

旧实现失败：`RefreshPricing completed while runtime pricing publication was incomplete`。真实批量事务已经提交 DB，并在运行时 OptionMap 发布屏障内持有 snapshot writer；旧强制刷新仍提前完成。

~~~text
bun test src/features/channel-price-compare/components/__tests__/price-sync-dialog-regression.test.tsx
~~~

旧实现 4 通过/2 失败：零官方 input 与 NaN tier 没有显示“官方价格不可用”，而是错误显示 overflow。首次导入判别 API 的纯逻辑用例为 0 通过/1 编译错误，证明 API 尚不存在。

~~~text
bun test src/features/channel-price-compare/lib/price-sync.test.ts
~~~

独立复审补充场景在首轮实现上 50 通过/2 失败：`groupRatio=Number.MIN_VALUE` 与 `input_audio=Number.MAX_VALUE, upstream_multiplier=2` 均误返 ready，而不是 overflow。

GREEN：

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 全仓 Go | `go test -json ./... -count=1` | 1325 tests / 35 packages 通过，0 失败 |
| 二次定价 race | `go test -race ./setting/ratio_setting ./model ./relay/helper ./service ./controller -run 'Test(ModelPricingSnapshot|RuntimePricingSyncData|FailedPricingSnapshotWrite|ExposedPricingData|UpdateOptionPublishesBillingConfigurationGeneration|UpdateOptionsBulkPublishesSingleRuntimePricingGeneration|LoadOptionsPublishesDatabasePricingAsOneGeneration|RuntimePricingReadersNeverObserveMixedGenerations|BillingConfigRefreshDoesNotTakePricingCacheLockInsideSnapshotWrite|RefreshPricingWaitsForRuntimePricingPublication|TieredBillingConfigRequiresExpressionInCoherentSnapshot|ModelPriceHelperTiered|BuildChannelPriceCompareRowPreservesModelsDevPurchaseSource|UpdatePricingOptionsUsesDatabase|LocalPricingSyncDataReadsTieredConfigFromRuntimeSnapshot)' -count=1` | 5/5 packages 通过；独立复审另将 model 屏障 race 连跑 3 次通过 |
| 前端单元+交互 | `bun test --coverage price-sync.test.ts price-sync-dialog.test.tsx price-sync-dialog-regression.test.tsx` | 64/64 通过 |
| TypeScript | `bun run typecheck` | 通过 |
| 生产构建 | `bun run build:check` | Rsbuild 通过 |
| changed-file lint/format | `bunx oxlint <4 个任务 TS/TSX 文件>`；`bunx oxfmt --check <4 个任务 TS/TSX + 5 locale 文件>` | 通过 |
| Go 格式与 diff | `gofmt -l model/pricing_refresh.go model/pricing_refresh_snapshot_test.go`；`git diff --check` | 无输出/通过 |
| locale delta | Bun HEAD delta consistency | 7/7 locale、2/2 键通过；五个目标 locale 均为非英文真翻译 |
| 独立复审 | 二次 Critical/Important/Minor 静态对账与 ad-hoc 边界验证 | PASS，无剩余审查缺口 |

### 二次覆盖率与兼容性

- `go test ./model -coverprofile=/tmp/final-review-wave2.cover.out -count=1`：model/pricing_refresh.go 的 RefreshPricing 为 100%；包整体 25.6% 为仓库既有基线。
- 前端定向 coverage：price-sync.ts 函数 100%、行 99.37%；price-sync-dialog.tsx 函数 88.89%、行 92.83%。
- 新增 model/pricing_refresh_snapshot_test.go；扩展 price-sync.test.ts 与 price-sync-dialog-regression.test.tsx。
- 无 schema/DDL、迁移、生产写入或对外 API 破坏；畸形官方目录数据现在会被拒绝，正常官方表达式与旧 plan/null wrapper 行为不变。
- 二次提交号：本追加报告所在的最终提交；Git 提交无法在自身内容中记录其最终哈希，实际 SHA 以交付回复为准。

### 二次剩余风险

1. 未改动的 logger/logger.go 全局 logCount 既有竞态仍会使不筛选的宽范围 race 失败；本次定价相关 race 5/5 包及强制刷新屏障连跑均通过。
2. 官方目录的非正 input、负/非有限成本、非安全整数或非递增 tier threshold 现在明确归为不可用；这是收紧畸形数据校验，不改变合法目录数据。
3. 原报告记录的 locale 全键集基线差异与既有超长 PriceSyncDialog 仍未越权重构；本次新增生产函数均满足 50 行上限。

## 三次最终复审追加（2026-08-14）

### 追加修复结论

| 复审项 | 根因 | 修复与证据 |
| --- | --- | --- |
| 官方表达式可写成零计费 | groupRatio 本身有限且为正，但乘以 `$2 / 1M` anchor 后的 divisor 可溢出 Infinity；旧预检只要求原始 coefficient 与 `coefficient * 1e9` 有限，没有验证实际九位 formatter 会不会把正系数舍入为 0 | newapi-onboard-pricing.ts 导出并复用实际九位量化器；price-sync.ts 在构建表达式前拒绝非有限/非正 divisor，并对 base 与全部 tiers 的 input/output/cache read/cache write/input audio/output audio 逐项量化。来源成本为正时，量化结果必须有限且大于 0；合法零 output/cache/audio 仍允许。Number.MAX_VALUE groupRatio 与正系数舍入为 0 均分类为 overflow；1e-9 最小可表示正系数及普通值保持 ready。 |
| 人工/探测非法 basis 被误报 overflow | resolveSyncBasis 只选来源不验数；computeSyncRatios 才拒绝 input=0 或其他非法值。弹窗因此认为 basis 已就绪，再把 null plan 归为算术溢出 | 统一 `isValidUpstreamCostBasis`：input 必须有限且大于 0，output/cache read/cache write 必须有限且不小于 0；resolver 与 ratio 计划共用该校验。非法人工/探测价返回维护采购价提示，不显示 overflow；选中的非法本地来源即使残留官方 marker 也不得静默切换 Models.dev。人工 input=0、探测 input=0 的真实组件交互均禁用提交且 provider 调用为 0；免费 output/cache 保持可规划。 |
| 基础 output 免费时分档少计费 | base output=0 合法，但旧生成器与预检把 outputScale 固定为 1；若 tier output/output_audio 为正，预览应用目标利润率，实际表达式却不加价 | base output 为 0 时，生成器与预检统一以 inputScale 作为同一目标利润率的 fallback。回归中 100% 目标利润率下 tier sellOutput=8，表达式同步为 `c * 4 + ao * 8`，不再生成少计费的 `c * 2 + ao * 4`。 |
| 持久化 Models.dev 被同时存在的探测价覆盖 | 后端先填 detected_available，再将完整采购价来源标为 models_dev，因此两者可同时为真；旧 resolver 在非 manual 分支直接选 detected，重开官方分档会静默改走 ratio | price_source=models_dev 现在是显式权威来源，resolver 不再选 detected，官方选择器也优先尊重持久化来源。真实组合的组件回归证明重开仍展示分档并提交 tiered_expr、models_dev 与 tiers。 |

### 三次 TDD 证据

RED：

~~~text
bun test price-sync-representability.test.ts price-sync-basis-validation.test.ts price-sync-dialog-regression.test.tsx
~~~

旧实现 9 通过/7 失败：Number.MAX_VALUE divisor 与正系数量化为 0 都误返 ready；人工/探测 zero input 仍被解析为 basis；负/非有限 output/cache 未在来源边界拒绝；两种组件交互没有展示采购价维护提示。

~~~text
bun test price-sync-representability.test.ts
~~~

追加免费 base output 分档场景 3 通过/1 失败：预览 tier sellOutput=8，但表达式实际为 `c * 2 + ao * 4`，期望 `c * 4 + ao * 8`。

~~~text
bun test price-sync-basis-validation.test.ts price-sync-dialog-regression.test.tsx
~~~

追加真实 `models_dev + detected_available` 组合 13 通过/2 失败：纯逻辑错误返回 detected basis；组件无法展示官方分档。

GREEN：

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| default 前端全量 | `bun test` | 240/240 通过 |
| 相关逻辑/组件/生成器 coverage | `bun test --coverage <price-sync 3 files + dialog 2 files + sub2api-onboard.test.ts>` | 85/85 通过 |
| TypeScript + 生产构建 | `bun run typecheck && bun run build:check` | 通过；Rsbuild 10.9s |
| changed-file lint/format | `bunx oxlint <5 files> && bunx oxfmt --check <5 files>` | 通过 |
| 后端相关 race 回归 | `go test -race ./service ./controller ./model -run 'Test(BuildChannelPriceCompareRowPreservesModelsDevPurchaseSource|RefreshPricingWaitsForRuntimePricingPublication|UpdatePricingOptionsUsesDatabase)' -count=1` | 3/3 packages 通过 |
| diff 健康 | `git diff --check` | 通过 |
| 独立边界矩阵 | base/tier 六类系数、basis、marker、免费值与持久化请求 | 241/241 通过 |
| 双重独立终审 | Critical/Important/明确 Minor 对账 | PASS，无剩余审查缺口 |

### 三次覆盖率与兼容性

- price-sync.ts：函数 100%，行 99.39%。
- price-sync-dialog.tsx：函数 88.89%，行 92.83%。
- newapi-onboard-pricing.ts：函数 92.31%，行 80.91%。
- 新增 price-sync-representability.test.ts、price-sync-basis-validation.test.ts；扩展 price-sync-dialog-regression.test.tsx。
- 无 schema/DDL、迁移、locale、生产写入或对外 API 破坏。九位量化器只是把生成器既有 formatter 变成共享真源。
- 三次提交号：本追加报告所在的最终提交；Git 提交无法在自身内容中记录其最终哈希，实际 SHA 以交付回复为准。

### 三次剩余风险

1. 任一正来源成本若在当前 group ratio 下只能量化为 0，会明确阻止同步并显示 overflow；这是防止静默免费计费的安全收紧，合法显式零 output/cache/audio 不受影响。
2. base output 免费而 tier output/audio 收费时，现在按 input 目标利润率生成表达式；这与“所有分档应用同一目标成本利润率”一致，但会纠正旧实现的少计费结果。
3. 原报告记录的 logger 既有竞态、locale 全键集基线差异与既有超长 PriceSyncDialog 未扩大；本次生产文件均低于 800 行，新增生产函数均不超过 50 行。

## 四次终审 Critical 修正追加（2026-08-14）

### 追加修复结论

本节明确撤销“三次最终复审追加”中“持久化 Models.dev 是显式权威来源”的错误结论；批准设计未修改，真实优先级始终是“完整人工价 → 有效探测价 → Models.dev 兜底 → missing”。

| 终审项 | 根因 | 修复与证据 |
| --- | --- | --- |
| Service 报表让持久化官方价压过有效探测 | `buildChannelPriceCompareRow` 只按四个采购价指针是否齐全决定最高优先级，之后才把 `source=models_dev` 改成官方标签；因此官方持久价与实时探测同时存在时永远进入第一个分支 | 将持久价拆为人工白名单（trim 后仅空串或 legacy `manual`）与官方价（`models_dev`），按人工 → 有效探测 → 官方 → missing 分支。人工即使残留官方 marker 仍优先；未知 source 不再伪装成人工价。Service 回归用不同的 9/45 官方价与 3/15 探测价证明最终 `price_source=detected` 且上游成本来自探测。 |
| “detected available” 接受零 input/派生非有限值 | 报表只校验原始 ratio 非负有限，四项美元成本算完后无条件置 available；group ratio=0 会得到零 input，有限原始倍率乘法仍可能溢出 Infinity | 新增派生成本门禁：input 必须有限且大于 0；output/cache read/cache write 必须有限且不小于 0。无效时 `detected_available=false` 并清零四个探测字段，防止 Infinity 破坏 JSON；零 input 与派生 overflow 均回退官方价并通过 `common.Marshal`。合法免费 output/cache 仍由相同非负规则允许。 |
| 前端再次提升持久化官方来源 | `resolveSyncBasis` 遇到 `price_source=models_dev` 直接返回 null，`shouldUseOfficialPricing` 又在 basis 之前优先官方，双重固化了反优先级 | resolver 保持人工首选，然后解析有效探测；selector 仅在没有有效 basis 时看显式官方 marker。有效探测 + persisted models_dev 的真实弹窗不访问 Models.dev、不展示 tier，提交 `billing_mode=ratio` 且没有 `purchase_price`；仅 `detected_available=false` 的重开场景继续提交 `tiered_expr + models_dev + tiers`。 |
| 无效人工/探测的兜底边界 | 上一波为避免非法 basis 被误报 overflow，将人工和探测都一概禁止官方兜底；这与“有效探测之后才到 Models.dev”不一致 | 无效人工价仍是操作员维护错误，不得静默改源；无效探测不构成有效第二优先级，有显式 marker 时进入 Models.dev 兜底。纯逻辑与组件均覆盖 zero detected，四类错误状态仍互斥。 |

### 四次 TDD 证据

RED：

~~~text
go test ./service -run 'TestBuildChannelPriceCompareRow(ManualPricePrecedesDetected|UsesDetectedBeforeModelsDev|FallsBackToModelsDevForInvalidDetection|UsesModelsDevWhenDetectionUnavailable|RejectsZeroInputDetectedBasis)$' -count=1
~~~

旧实现 5 个顶层用例中 3 个失败：官方来源仍压过 3/15 探测价；零 input 与派生 Infinity 仍标记 `detected_available=true`；无官方兜底时零 input 仍错误返回 ok。

~~~text
bun test price-sync-basis-validation.test.ts price-sync-dialog-regression.test.tsx
~~~

旧实现 13 通过/4 失败：有效探测仍被 persisted models_dev 压过；zero detected 不进入官方兜底；真实弹窗未展示 detected basis，也无法提交 ratio 请求。

~~~text
go test ./service -run '^TestBuildChannelPriceCompareRowDoesNotTreatUnknownSourceAsManual$' -count=1
~~~

独立复审追加 RED：旧实现把未知 per-model `source=newapi` 当成人工价，实际返回 manual/9，期望 detected/3。

GREEN：

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| Service 聚焦回归 | `go test ./service -run 'TestBuildChannelPriceCompareRow(...)$' -count=1` | 6/6 顶层用例通过，共 8 个叶子用例 |
| Service 全包 | `go test ./service -count=1` | 通过，4.845s |
| Service race | `go test -race ./service -run 'TestBuildChannelPriceCompareRow(...)$' -count=1` | 通过，1.994s |
| 前端聚焦逻辑/组件 | `bun test price-sync-basis-validation.test.ts price-sync-dialog-regression.test.tsx` | 17/17 通过 |
| 前端相关链路 | `bun test <price-sync 3 files + dialog 2 files + sub2api-onboard.test.ts>` | 87/87 通过 |
| default 前端全量 | `bun test` | 242/242 通过 |
| 相关链路 coverage | `bun test --coverage <上述 6 文件>` | 87/87；price-sync.ts 函数 100%、行 99.38%；price-sync-dialog.tsx 函数 88.89%、行 92.83% |
| TypeScript + 生产构建 | `bun run typecheck && bun run build:check` | 通过；Rsbuild 11.4s |
| changed-file lint/format | `bunx oxlint <3 files> && bunx oxfmt --check <3 files>`；`gofmt -l <2 files>` | 通过 |
| diff 健康 | `git diff --check` | 通过 |
| 独立复审 | producer → API → resolver → dialog → request 对账及 JSON 安全复核 | PASS，无剩余 Critical、Important 或明确 Minor |

### 四次覆盖率、兼容性与剩余风险

- 新增/扩展 `service/channel_price_compare_test.go`、`price-sync-basis-validation.test.ts`、`price-sync-dialog-regression.test.tsx`；测试覆盖 canonical 空 source 与 legacy `manual`、未知 source、有效/零值/溢出探测、官方有无探测两种重开请求。
- 无 schema/DDL、迁移、locale、生产写入或对外 API 字段变更。报表只纠正既有字段的来源与有效性；invalid detected 的四个诊断数值归零并以 `detected_available=false` 明确表示不可用。
- 显式 `manual` 仅作为历史直写数据的读取兼容；canonical 人工价仍以空 source 持久化。未知 source 在无有效探测和官方价时会进入 missing，不再被误当可信人工价。
- 原报告记录的未改动 logger 既有竞态、locale 全键集基线差异与既有超长组件仍未扩大；本波新增生产 helper 均不超过 50 行。
- 四次提交号：本追加报告所在的最终提交；Git 提交无法在自身内容中记录其最终哈希，实际 SHA 以交付回复为准。
