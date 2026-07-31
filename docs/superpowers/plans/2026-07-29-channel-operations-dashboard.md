# Channel Operations Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为管理员提供渠道 Token 采购价维护、收入成本对比、实际选路、今日/累计使用和质量建议。

**Architecture:** 在渠道现有 `settings` JSON 中保存按站内模型键控的采购价；扩展现有价格对比服务，合并 `abilities`、渠道、自动探测价和日志聚合；前端复用现有管理员路由，增加渠道价格表单和两层经营观察界面。

**Tech Stack:** Go 1.25、Gin、GORM、React 19、TypeScript、React Query、React Hook Form、Zod、Vitest、Bun。

## Global Constraints

- 仅管理员可见菜单、页面和接口；普通用户直接访问返回 403。
- 仅覆盖 Token 模型；所有价格为美元 / 1M Token，美元汇率固定 1:1。
- 手工采购价优先，自动探测价兜底；缺价不计算利润。
- 只给管理建议，不自动修改渠道。
- SQLite、MySQL、PostgreSQL 全部兼容；不新增数据库结构。
- 所有新增前端文案使用 i18n。

---

### Task 1: 渠道采购价数据契约

**Files:**
- Modify: `dto/channel_settings.go`
- Modify: `model/channel.go`
- Test: `model/channel_settings_test.go`

**Interfaces:**
- Produces: `dto.ChannelModelPrice`、`ChannelOtherSettings.PACUpstreamGroup`、`ChannelOtherSettings.ModelPrices`；采购价按站内模型名读取。

- [x] **Step 1: 写失败测试**：覆盖合法价格读回、负数拒绝、空模型键拒绝、已移除模型价格清理。
- [x] **Step 2: 验证失败**：运行 `go test ./model -run 'TestChannel.*Price' -count=1`，确认因字段或校验缺失失败。
- [x] **Step 3: 最小实现**：增加 `input/output/cache_read/cache_write` 可选价格结构；在渠道校验中拒绝非有限数与负数；保存前仅保留 `channel.GetModels()` 中存在的键。
- [x] **Step 4: 验证通过**：重复运行目标测试。

### Task 2: 管理员经营报告服务

**Files:**
- Modify: `service/channel_price_compare.go`
- Modify: `controller/channel_price_compare.go`
- Test: `service/channel_price_compare_test.go`
- Test: `controller/channel_price_compare_test.go`

**Interfaces:**
- Consumes: Task 1 的采购价结构。
- Produces: 扩展后的 `BuildChannelPriceCompareReport(ctx, group)`，含今日汇总、渠道汇总、模型渠道明细、调度角色、价格来源、累计/今日/24h 指标和建议。

- [x] **Step 1: 写失败服务测试**：固定 SQLite 主库/日志库，建立主用、同优先级分流、备用渠道与消费/错误日志，断言价格优先顺序、调度角色、收入、成本、盈利、今日边界和建议。
- [x] **Step 2: 验证失败**：运行 `go test ./service -run TestBuildChannelPriceCompareReport -count=1`。
- [x] **Step 3: 最小实现**：一次加载启用渠道与 abilities；分别聚合累计、北京时间今日和近 24h 日志；按当前有效采购价计算预估成本；探测错误按渠道保留且不阻断报告。
- [x] **Step 4: 写失败控制器权限/响应测试**：断言响应不含 key/token，内部错误仅记录在服务端。
- [x] **Step 5: 实现并验证**：运行 `go test ./service ./controller -run 'ChannelPriceCompare' -count=1`。

### Task 3: 渠道编辑采购价

**Files:**
- Modify: `web/default/src/features/channels/lib/channel-form.ts`
- Modify: `web/default/src/features/channels/components/drawers/channel-mutate-drawer.tsx`
- Modify: `web/default/src/features/channels/types.ts`
- Test: `web/default/src/features/channels/lib/channel-model-prices.test.ts`

**Interfaces:**
- Consumes/produces: `settings.pac_upstream_group` 与 `settings.model_prices[model]`。

- [x] **Step 1: 写失败测试**：渠道转表单、表单转请求、模型移除清理、0 值保留、负数 Zod 校验。
- [x] **Step 2: 验证失败**：运行 `bun test src/features/channels/lib/channel-model-prices.test.ts`。
- [x] **Step 3: 最小实现**：在现有模型区增加上游计费分组和采购价表；显示站内模型到上游模型映射；不暴露敏感字段。
- [x] **Step 4: 验证通过**：重复运行目标测试并执行 `bun run typecheck`。

### Task 4: 直观经营观察页

**Files:**
- Modify: `web/default/src/features/channel-price-compare/types.ts`
- Modify: `web/default/src/features/channel-price-compare/index.tsx`
- Replace: `web/default/src/features/channel-price-compare/components/price-compare-table.tsx`
- Create: `web/default/src/features/channel-price-compare/components/channel-summary-table.tsx`
- Create: `web/default/src/features/channel-price-compare/lib/formatters.ts`
- Test: `web/default/src/features/channel-price-compare/lib/formatters.test.ts`
- Modify: `web/default/src/hooks/use-sidebar-data.ts`
- Modify: `web/default/src/i18n/locales/en.json`
- Modify: `web/default/src/i18n/locales/zh.json`

**Interfaces:**
- Consumes: Task 2 报告。
- Produces: 管理员“渠道经营观察”页面，顶部今日卡片、渠道汇总表、模型候选渠道对比、筛选排序和编辑/日志入口。

- [x] **Step 1: 写失败测试**：金额/毛利/状态格式、风险排序、筛选汇总和无价格占位。
- [x] **Step 2: 验证失败**：运行 `bun test src/features/channel-price-compare/lib/formatters.test.ts`。
- [x] **Step 3: 最小实现**：采用密集运营台布局；成本、收入、盈利并列；风险行突出；移动端横向滚动；所有按钮有可访问名称。
- [x] **Step 4: 权限检查**：保留路由 `ROLE.ADMIN` 判断、管理员侧栏分组和后端 `AdminAuth + ChannelRead`。
- [x] **Step 5: 验证通过**：运行目标测试、`bun run typecheck`、涉及文件 lint。

### Task 5: 综合验证、审查、发布

**Files:**
- Modify only when verification exposes a defect.

- [x] **Step 1: 后端验证**：运行目标 Go 测试和全部后端测试。
- [x] **Step 2: 前端验证**：运行全部前端测试、typecheck、lint、production build。
- [x] **Step 3: 浏览器验证**：启动真实前端与受控本地 API，管理员验证价格编辑、总体卡片、筛选汇总、排序、展开和精确编辑入口；普通用户验证菜单隐藏和 403。
- [x] **Step 4: 独立审查**：独立复核业务口径、权限、安全、性能和兼容性并修复阻断问题。
- [ ] **Step 5: 发布**：按 `push-to-main` 合并推送；检查并合并上游；等待 `fork-latest` 镜像构建；通过个人阿里云账号封装执行生产部署。
- [ ] **Step 6: 生产验证**：核对容器镜像、健康接口、管理员页面/API、普通用户不可见，并用生产真实渠道数据检查至少一组价格、收入、成本与实际命中。