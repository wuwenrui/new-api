# Task 5 报告：Grok 4.6 最高档统一采购价

日期：2026-08-14

## 交付结果

- 仅当请求模型和 Models.dev 解析模型都精确为 `grok-4.6`，且至少存在一个 `context_threshold >= 200000` 的上下文档时，选择合格档位中阈值最大的档位作为统一成本；相似名称和其他官方模型继续生成分档表达式。
- Grok 弹窗使用最高档输入、输出和缓存成本计算默认成本利润率及预览，不展示上下文分档。5000% 首次提交 `ratio` 与统一采购价，保存后以人工采购价重开仍反显 5000%，且不再请求 Models.dev。
- 后端只接受显式 `ratio + purchase_price` 的 Grok 统一价契约：模型精确匹配、渠道为正、来源为 `manual`、provider/官方字段为空、tiers 未携带、四项价格齐全且有限；输入必须大于 0，其余三项允许为 0。
- 倍率、旧 mode/expr 清理和渠道统一采购价在同一数据库事务内完成；渠道写入或渠道设置解析失败时全部回滚。事务路径不再调用会通过全局 DB 自行保存的容错解析逻辑。
- 渠道全局 Models.dev 来源标记和其他模型采购价保持不变，单模型人工价覆盖官方价。

## TDD 证据

### RED

1. 前端：

   ```text
   bun test src/features/channel-price-compare/lib/price-sync.test.ts \
     src/features/channel-price-compare/components/__tests__/price-sync-dialog-regression.test.tsx
   ```

   实现前结果：61 pass、5 fail。失败覆盖缺少计费模式区分、Grok 未折叠最高档、无 tier 未拒绝，以及弹窗仍显示基础成本。

2. 后端主契约：

   ```text
   go test ./controller -run 'TestUpdatePricingOptions(AtomicallyWritesGrok46UnifiedPurchasePrice|RollsBackGrok46RatioWhenPurchasePriceWriteFails|RejectsUnsafeGrok46UnifiedPurchasePrice)$' -count=1
   ```

   实现前结果：FAIL。统一采购价被忽略、渠道失败注入未触发、非法来源和 tiers 被接受。

3. 后端补充边界：

   ```text
   go test ./controller -run 'Test(UpdatePricingOptionsPreservesMalformedChannelSettingsWhenGrok46WriteFails|ValidatePricingOptionsRequestAllowsZeroGrok46OutputAndCacheCosts|ValidatePricingOptionsRequestRejectsNonFiniteGrok46PurchaseCosts)$' -count=1
   ```

   实现前结果：FAIL；畸形渠道设置仍返回成功，非有限价格未拒绝。其余三价为 0 的合法边界已通过。

### GREEN

- 后端聚焦契约：PASS；成功写入、非法请求、缺四价、零值边界、NaN/Inf、渠道写失败和畸形设置回滚全部通过。
- 前端聚焦：70 pass、0 fail，覆盖计算、请求体、交互重开及既有表达式可表示性。
- 后端相关包：`go test ./controller ./model -count=1` PASS。
- Go 全量：`go test ./... -count=1` PASS。
- 前端全量：`bun test`，246 pass、0 fail。
- 类型与生产构建：`bun run build:check` PASS。
- Go 静态检查：`go vet ./controller ./model` PASS。
- changed lint：6 个变更 TS/TSX 文件执行 oxlint，0 error。
- changed format：6 个变更 TS/TSX 文件执行 oxfmt check，PASS；4 个 Go 文件 gofmt check，PASS。
- 差异检查：`git diff --check` PASS；生产代码差异敏感凭证模式扫描无命中。

## 覆盖率

- 前端 `bun test --coverage`：`price-sync.ts` functions 100%、lines 99.13%；`price-sync-dialog.tsx` functions 88.89%、lines 92.83%。
- 后端 controller/model 全测试联合覆盖：新增统一价校验 100%、定价更新接口 93.5%、渠道价格归一化 83.3%、事务内渠道价格写入 85.2%。
- controller/model 两个大包的整体语句覆盖率为 20.8%，属于仓库现有测试广度；本任务改动函数均达到 80%。

## 非阻塞基线问题

- `go test -race ./controller ./model -count=1`：`model` 通过；`controller` 被既有订阅通知异步测试的全局变量清理竞态阻断，竞态位于 `controller/subscription_entitlement_test.go:51` 与 `service/notify-limit.go:51`，不在本任务调用链。Task 5 聚焦 controller race 通过。
- 全量前端 lint 和 protected-header-safe format check 存在大量未触及文件的既有失败；本任务要求的 changed lint/format 均通过，失败文件不含本任务文件。

## 独立终审

- 契约与前端双重独立审查未发现 Critical 或可复现 Minor；最终审查指出并已修复一个 Important：Grok 4.6 的统一价档位必须显式达到 200K 上下文，不能仅取任意非空 tiers 的最大值。
- 终审重点核对 exact model、200K 最低门槛与合格档位最高阈值、人工来源、四价边界、事务回滚、其他官方模型分档和 5000% 重开路径。

## 数据库与兼容性

- 无 DDL、迁移脚本或数据回填。
- 普通旧 ratio 请求未携带 `purchase_price` 时行为不变；其他官方模型仍使用 Models.dev 分档路径。
- 本任务不自动修改生产数据，只改变管理员执行“应用售价”后的原子保存行为。

## 终审修正：200K 最低门槛

- RED：新增计算单测与弹窗交互测试后，聚焦命令得到 66 pass、2 fail；仅有 128K tier 时仍被错误判定为可用，并可进入提交路径。
- GREEN：精确 `grok-4.6` 仅从 `context_threshold >= 200000` 的 tiers 中取最大阈值；无合格 tier 时返回不可用。既有 200K 与 1M 多档测试继续验证选择 1M，其他模型分档逻辑未改。
- 聚焦前端：68 pass、0 fail；前端全量：248 pass、0 fail。
- 后端统一价事务契约聚焦测试：PASS；`bun run typecheck`、3 个变更 TS/TSX 文件的 oxlint 与 oxfmt check、`git diff --check`：PASS。
