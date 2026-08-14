# Channel Price Sync Cost Profit Rate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复“同步售价”错误回退 Models.dev 官方价的问题，并将“加价率”改为允许超过 100% 的“目标成本利润率（利润 ÷ 成本）”。

**Architecture:** 前端统一由采购价来源判定同步基准，人工采购价优先于探测价和 Models.dev；普通比例售价请求显式声明 `billing_mode: ratio`。后端在同一事务内写入模型倍率并清除该模型旧的上下文分档表达式，保持渠道人工采购价不变。

**Tech Stack:** Go 1.25、Gin、GORM、React 19、TypeScript、TanStack Query、Node Test、Bun。

## Global Constraints

- 人工采购价优先；只有人工价和探测价均不可用时才使用 Models.dev。
- 成本利润率公式为 `(售价 - 成本) / 成本 × 100%`，允许超过 100%；预览继续显示毛利率。
- 人工统一采购价不生成上下文分档；应用售价后显式切换为普通倍率计费。
- 切换必须原子更新，失败时不得留下“倍率已变、计费模式未变”的半完成状态。
- 不新增数据库结构，不修改生产数据，不改动无关文件。

---

### Task 1: 采购价优先与成本利润率纯逻辑

**Files:**
- Modify: `web/default/src/features/channel-price-compare/lib/price-sync.ts`
- Test: `web/default/src/features/channel-price-compare/lib/price-sync.test.ts`
- Modify: `web/default/src/features/system-settings/types.ts`

**Interfaces:**
- Produces: 人工价优先的同步基准、成本利润率计算/解析、显式 `billing_mode: ratio` 请求。

- [x] **Step 1: 写失败测试**：覆盖人工价压过探测价和官方标记、0%/100%/455.56% 成本利润率、负数拒绝、比例请求包含 `billing_mode: ratio`。
- [x] **Step 2: 验证失败**：运行 `bun test src/features/channel-price-compare/lib/price-sync.test.ts`。
- [x] **Step 3: 最小实现**：调整来源优先级；重命名成本利润率辅助函数；保持公式不变；扩展比例请求类型。
- [x] **Step 4: 验证通过**：重复运行目标测试。

### Task 2: 原子切换普通倍率计费

**Files:**
- Modify: `controller/option.go`
- Test: `controller/option_pricing_test.go`

**Interfaces:**
- Consumes: `billing_mode: ratio` 的售价同步请求。
- Produces: 在现有原子事务中写入倍率、清除当前模型的分档模式和表达式；省略计费模式的旧请求保持原行为。

- [x] **Step 1: 写失败集成测试**：从分档模型提交显式普通倍率请求，断言响应成功、倍率写入、当前模型分档配置删除、其他模型配置保留、渠道人工采购价不变。
- [x] **Step 2: 验证失败**：运行 `go test ./controller -run 'TestUpdatePricingOptionsAtomicallySwitchesTieredModelToRatio' -count=1`。
- [x] **Step 3: 最小实现**：校验显式普通倍率模式；构建配置时仅对该模式清理当前模型分档键；复用现有事务写入。
- [x] **Step 4: 回归验证**：运行 `go test ./controller -run 'TestUpdatePricingOptionsAtomically|TestValidatePricingOptions' -count=1`。

### Task 3: 同步售价界面与文案

**Files:**
- Modify: `web/default/src/features/channel-price-compare/components/price-sync-dialog.tsx`
- Test: `web/default/src/features/channel-price-compare/components/__tests__/price-sync-dialog.test.tsx`
- Modify: `web/default/src/i18n/locales/en.json`
- Modify: `web/default/src/i18n/locales/zh.json`
- Modify: other locale files through `bun run i18n:sync`

**Interfaces:**
- Consumes: Task 1 的人工价优先同步基准。
- Produces: “目标成本利润率（利润 ÷ 成本）”输入、比例说明、人工统一价预览和普通倍率请求。

- [x] **Step 1: 写失败组件测试**：官方标记且存在人工价时显示人工采购价、不显示官方分档；显示新标签和 100%/455.56% 解释。
- [x] **Step 2: 验证失败**：运行组件目标测试。
- [x] **Step 3: 最小实现**：调整官方价查询开关、变量和控件命名；保留毛利率预览；更新中英文文案并同步语言文件。
- [x] **Step 4: 验证通过**：运行组件测试、`bun run typecheck`、`bun run format:check`。

### Task 4: 综合验证与交付

**Files:**
- Modify only when verification exposes a defect.

- [x] **Step 1: 后端验证**：运行 `go test ./controller -count=1` 和 `go test ./... -count=1`。
- [x] **Step 2: 前端验证**：运行两组目标测试、`bun run typecheck`、`bun run lint`、`bun run format:check`、`bun run build:check`。
- [x] **Step 3: 变更审查**：检查差异仅覆盖本需求，确认无密钥、无数据库迁移、无无关文件。
- [x] **Step 4: 完成分支验证**：依据 finishing-a-development-branch 与 verification-before-completion 门禁复跑关键命令并汇报。

### Task 5: Grok 4.6 最高档统一采购价

**Files:**
- Modify: `web/default/src/features/channel-price-compare/lib/price-sync.ts`
- Modify: `web/default/src/features/channel-price-compare/components/price-sync-dialog.tsx`
- Modify: `web/default/src/features/system-settings/types.ts`
- Modify: `controller/option.go`
- Test: frontend pricing and dialog regression tests
- Test: `controller/option_pricing_test.go`

- [x] **Step 1: 写失败测试**：Grok 4.6 选择最高阈值档、不展示分层、5000% 提交 ratio + 统一采购价、重开仍为 5000%。
- [x] **Step 2: 后端失败测试**：ratio 请求原子写入统一采购价并清旧分层；写入失败全回滚；非法来源/tiers 拒绝。
- [x] **Step 3: 最小实现**：仅对 `grok-4.6` 折叠最高档；扩展 ratio 请求携带渠道采购价；复用现有事务。
- [x] **Step 4: 验证通过**：目标测试、Go 全量/race、前端全量、typecheck、build、changed lint/format。

### Task 6: 新需求终审与交付

- [x] **Step 1: 整分支审查**：确认 Grok 例外不影响其他官方分档模型。
- [x] **Step 2: 新鲜复验**：按 verification-before-completion 串行复跑关键门禁。
