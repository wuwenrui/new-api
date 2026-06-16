# 充值 Bark 通知 + 管理员待确认充值页（方案 B）

日期: 2026-06-16
仓库: new-api（fork，部署分支 `deploy/manual-qr-topup`）
范围: 仅后端 Go + 前端 `web/default`（不动 `web/classic`）

## 1. 背景与目标

生产模型站 `model.codingrui.work` 已启用站内人工充值：用户在钱包页选微信/支付宝、扫码付款、提交 → 建一条 `pending` 的 `top_ups` 订单（`payment_provider=manual_topup`），自动给 root 用户发通知；管理员去后台确认到账后补单入账。现状缺口：

1. 通知是纯文本、**无可点链接**，且 root 当前通知方式=email、未配 Bark。
2. 补单只能去钱包内 `BillingHistoryDialog` 列表里翻，**没有「点通知直达、显示该用户+申请金额、可调金额后一键充值」的页面**。
3. 生产已积压 17 笔 pending 人工单未确认。

目标（已与用户确认）:
- 用户提交人工充值后，通过 **Bark** 给管理员推送，**点推送直达**一个待确认充值页。
- 该页列出待确认人工单（谁/申请额度/¥/方式/时间），可定位到本单；管理员**可调整金额后**一键充值。

## 2. 关键约束（不可破坏）

- 三库兼容（SQLite/MySQL/PostgreSQL）：用 GORM 抽象，避免 DB 专有语法。
- JSON 必须走 `common.Marshal/Unmarshal`，禁止直接 `encoding/json`（`new-api/CLAUDE.md` Rule 1）。
- 受保护品牌 `new-api` / `QuantumNous` 一律不动（Rule 5）。
- 前端沿用本仓库既有技术栈：**axios + eslint + Rsbuild + TanStack Router**（不引入 ky/biome/vitest，遵循仓库现状而非全局默认）。
- 红线：不得放松既有约束。本设计对既有补单/支付路径**只增不改**——`ManualCompleteTopUp` 原逻辑保持不变；新增金额可调路径并行存在。

## 3. 金额/单位口径（已核对生产数据）

- `common.QuotaPerUnit = 500000`（`common/constants.go:62`）。
- 人工单入账公式（`model/topup.go:354-364`）：非 Stripe 单 `quotaToAdd = top_ups.amount × QuotaPerUnit`。
- `top_ups.amount` 为「美元/单位」整数（展示类型=TOKENS 时已在建单时 `/QuotaPerUnit` 归一，见 `controller/topup.go:233-240`）。
- `top_ups.money` = 实付金额 = `getPayMoney(requestAmount, group)`（`controller/topup.go:270-298`，含分组倍率与折扣）。
- 生产实测：`Price=1`、`USDExchangeRate=1`、`QuotaDisplayType` 默认；真实 pending 单 `amount==money`（如 50→50），另有分组倍率 7.3 的单（amount=1→money=7.3）。

**改金额口径**：管理员编辑的是 `top_ups.amount`（整数，默认=订单当前 amount）。后端：
- `quotaToAdd = newAmount × QuotaPerUnit`；
- `newMoney = oldMoney × newAmount / oldAmount`（decimal 等比缩放，`oldAmount>0` 时；与展示类型无关、保留分组倍率）。
- 注：等比缩放不重算「按特定金额配置的折扣档」（`AmountDiscount`），管理员手工覆盖场景可接受。

## 4. 后端改动（均为新增，既有路径不改语义）

### 4.1 配置项（3 个）
`setting/operation_setting/payment_setting.go`（在第 28 行 `ManualTopUp*` 变量块后追加）:
```go
var RechargeNotifyEnabled = false
var RechargeNotifyBarkUrl = ""
var RechargeNotifyLinkBase = ""
```
`model/option.go`:
- `InitOptionMap()`（约第 88 行后）seed 默认：
  ```go
  common.OptionMap["RechargeNotifyEnabled"] = strconv.FormatBool(operation_setting.RechargeNotifyEnabled)
  common.OptionMap["RechargeNotifyBarkUrl"] = operation_setting.RechargeNotifyBarkUrl
  common.OptionMap["RechargeNotifyLinkBase"] = operation_setting.RechargeNotifyLinkBase
  ```
- `updateOptionMap()`：bool 进 `HasSuffix(key,"Enabled")` 那个 switch（约 368 行后）`case "RechargeNotifyEnabled": operation_setting.RechargeNotifyEnabled = boolValue`；两个 string 进主 switch（约 415 行后）`case "RechargeNotifyBarkUrl"/"RechargeNotifyLinkBase": operation_setting.X = value`。
- 无 key 白名单、`PUT /api/option/`(RootAuth) 自动持久化，无需改路由/控制器。

`RechargeNotifyBarkUrl` 期望格式：`https://api.day.app/<your-device-key>/{{title}}/{{content}}`（`{{title}}/{{content}}` 由 sendBark 替换，url 透传见 4.2）。

### 4.2 Bark 深链通知
`service/user_notify.go`：把 `sendBarkNotify` 的核心抽到 `sendBarkRequest(barkURL string, data dto.Notify, deepLink string) error`（复用现有占位符替换 + SSRF/worker 逻辑），`sendBarkNotify` 改为 `return sendBarkRequest(barkURL, data, "")`（保持原行为不变）。当 `deepLink != ""` 时，在最终 URL 上追加 Bark 点击跳转参数：`?url=<QueryEscape(deepLink)>`（若 URL 已含 `?` 则用 `&`）。

新增 `service.NotifyRechargePending(userID int, tradeNo, paymentName string, displayAmount int64, payMoney float64) (sent bool)`（建议放新文件 `service/recharge_notify.go`）:
- 读 `operation_setting.RechargeNotifyEnabled / RechargeNotifyBarkUrl / RechargeNotifyLinkBase`。
- `!Enabled || BarkUrl==""` → 返回 `false`（调用方回退旧通知）。
- `linkBase` = `RechargeNotifyLinkBase`，为空则 `service.GetCallbackAddress()`（`service/epay.go:8-13`，无尾斜杠）。
- `deepLink = linkBase + "/recharge-review?trade_no=" + url.QueryEscape(tradeNo)`。
- 标题/正文（含 userID、申请额度、应收 ¥）。调 `sendBarkRequest(barkURL, notify, deepLink)`；**发送失败**时 `common.SysLog` 记录并返回 `false`（调用方回退 email，避免管理员漏收）；成功返回 `true`。

### 4.3 接入建单流程
`controller/topup.go:449` 处，把当前：
```go
service.NotifyRootUser(dto.NotifyTypeManualTopUp, notification.Subject, notification.Content)
```
改为 fire-and-forget（`gopool.Go`，避免 Bark 网络调用阻塞用户请求）+ 回退：
```go
gopool.Go(func() {
    if !service.NotifyRechargePending(id, tradeNo, manualMethod.Name, req.Amount, payMoney) {
        service.NotifyRootUser(dto.NotifyTypeManualTopUp, notification.Subject, notification.Content)
    }
})
```
（`gopool` 已在仓库使用，import `github.com/bytedance/gopkg/util/gopool`，对齐 `service/quota.go:488`。）

### 4.4 金额可调补单
`model/topup.go` 新增 `AdminCompleteManualTopUp(tradeNo string, overrideAmount int64, callerIp string) error`：
- 事务 + 行锁（`FOR UPDATE`），与 `ManualCompleteTopUp` 同款 `refCol` 三库兼容写法。
- 幂等：`status==Success` 直接返回 nil。
- 校验：`status` 必须 `Pending`；`payment_provider` 必须 `PaymentProviderManualTopUp`（否则返回错误「仅人工充值订单支持调整金额」）；`overrideAmount <= 0` 返回「无效的充值额度」。
- `oldAmount := topUp.Amount`；`if oldAmount > 0 { topUp.Money = decimal(oldMoney).Mul(overrideAmount).Div(oldAmount).InexactFloat64() }`。
- `topUp.Amount = overrideAmount`；`quotaToAdd = decimal(overrideAmount).Mul(QuotaPerUnit).IntPart()`，`>0` 校验。
- 置 `CompleteTime/Status=Success`、`Save`、`Update("quota", gorm.Expr("quota + ?", quotaToAdd))`。
- 事务外 `RecordTopupLog(... "管理员调整金额补单成功" ...)`。

`controller/topup.go` `AdminCompleteTopupRequest` 增加可选字段：
```go
type AdminCompleteTopupRequest struct {
    TradeNo string `json:"trade_no"`
    Amount  *int64 `json:"amount"` // 可选；仅人工单生效
}
```
`AdminCompleteTopUp` 逻辑（保持订单锁）：
- `Amount == nil` → 走旧 `model.ManualCompleteTopUp(tradeNo, ip)`（**完全不变**）。
- `Amount != nil`：查单确认 `payment_provider==manual_topup`，否则报错「仅人工充值订单支持调整金额」；调 `model.AdminCompleteManualTopUp(tradeNo, *Amount, ip)`。

### 4.5 待确认人工单查询接口（新增，additive）
`model/topup.go` 新增 `GetPendingManualTopUps(pageInfo)`：`WHERE payment_provider = 'manual_topup' AND status = 'pending' ORDER BY id DESC`，分页。
`controller/topup.go` 新增 `GetPendingManualTopUps(c)`：取分页结果后，批量查 `users(id, username, email)` 拼装返回项（用 DTO 或 `gin.H`，含 `username/email`）。响应沿用 `pageInfo` 包装。
`router/api-router.go` adminRoute（第 128-148 块）新增：`adminRoute.GET("/topup/pending-manual", controller.GetPendingManualTopUps)`。

## 5. 前端改动（`web/default`，遵循仓库现状）

### 5.1 新建管理员路由（深链目标）
`src/routes/_authenticated/recharge-review/index.tsx` → URL `/recharge-review`。
- `createFileRoute` + `beforeLoad` role 守卫（`role < ROLE.ADMIN` → redirect `/403`），照抄 `routes/_authenticated/finance-report/index.tsx` 与 `users/index.tsx:40-52`。
- `validateSearch: z.object({ trade_no: z.string().optional().catch(undefined) })`，组件 `Route.useSearch()` 取 `trade_no` 做定位高亮/自动打开确认框。

### 5.2 feature 模块 `src/features/recharge-review/`
- `api.ts`：`getPendingManualTopUps(page,pageSize)` → `GET /api/user/topup/pending-manual`；`completeOrderWithAmount({trade_no, amount})` → `POST /api/user/topup/complete`（`amount` 整数）。复用 `@/lib/api` 的 `api` 实例与 `ApiResponse` 信封。
- `types.ts`：`PendingManualTopUp { id,user_id,username,email,amount,money,payment_method,create_time,trade_no,status }`。
- `lib.ts`（**纯函数，便于单测**）：
  - `previewQuota(amount): string`（按展示口径预览，简单用 `amount` 数值 + 可选 ¥）；
  - `buildCompletePayload(tradeNo, amount): {trade_no, amount}`；
  - `findOrderIndexByTradeNo(list, tradeNo): number`。
- `index.tsx`：列表（用户=username/email + id、申请额度、应收 ¥、方式、时间、状态）；每行「确认充值」打开确认框：**金额输入框默认=申请额、可改**，旁注「将给用户充值 = <预览>」；提交调 `completeOrderWithAmount` → 成功后刷新列表 + toast。`trade_no` 命中则滚动/高亮该行并自动打开其确认框。
- UI 组件复用 `@/components/ui/*` 与 `BillingHistoryDialog`/`finance-report` 现有风格。

### 5.3 侧栏与路由模块登记
- `src/hooks/use-sidebar-data.ts` admin 分组（约 120-165）新增条目 `{ title: t('待确认充值'), url: '/recharge-review', icon: <lucide icon> }`，与 `finance-report` 同样按 `ROLE.ADMIN` 可见。
- `src/hooks/use-sidebar-config.ts`：URL→section/module 映射 + `DEFAULT_SIDEBAR_MODULES` admin 下登记新模块（照 finance-report 现有处理）。

### 5.4 i18n
新增用到的英文 key 到 `src/i18n/locales/en.json` 与 `zh.json`（zh 给中文文案；其余语言可留英文）。优先手动补 en/zh，避免依赖 `i18n:sync` 联网。

## 6. 安全

- 新页面与所有相关 API 走 `AdminAuth()`（role≥10）；`PUT /api/option/` 走 `RootAuth()`（既有）。
- 通知里的链接只是打开 UI，**不是点开即加钱**——必须登录 + 在页面点确认才入账。
- Bark URL / 域名经配置项存库，不入代码；深链域名用公网 HTTPS（`https://model.codingrui.work`），**不可**用 `ServerAddress` 的 IP。
- 深链 `trade_no` 经 `url.QueryEscape`；前端 `validateSearch` zod 校验；金额后端再校验（>0、仅人工单）。

## 7. 测试（必须全绿才汇报）

Go（`cd new-api`，sqlite 内存库，testify，参考 `service/finance_report_test.go:16-43`、`controller/topup_manual_test.go`）:
- `model/topup_admin_complete_test.go`：`AdminCompleteManualTopUp` 覆盖——按 override 正确入账（quota=newAmount×500000）、money 等比缩放、幂等（重复调用不重复加额）、拒绝非人工单、拒绝 `overrideAmount<=0`、仅 pending 可补、并发/行锁路径可走通。
- `controller/topup_admin_complete_test.go`：`AdminCompleteTopUp` 路由——`amount==nil` 走旧逻辑、`amount!=nil` 走 override、非人工单带 amount 被拒。
- `model/topup_pending_manual_test.go`：`GetPendingManualTopUps` 只返回 pending+manual、分页正确。
- `service/recharge_notify_test.go`：`NotifyRechargePending` 未启用/无 BarkUrl → `false`；`sendBarkRequest` 深链拼接（含 `?url=`/`&url=` 分支、`{{title}}/{{content}}` 替换）；linkBase 回退 `GetCallbackAddress`。用本地 `httptest.Server` 当 Bark 端点断言收到的 URL。
- `go build ./...` 通过；相关包 `go test ./...` 通过。

前端（`cd web/default`，`node:test`+`node:assert` 风格，参考 `src/hooks/sidebar-finance-access.test.ts`）:
- `src/features/recharge-review/lib.test.ts`：`buildCompletePayload`、`findOrderIndexByTradeNo`、`previewQuota` 纯函数断言。
- `bun run typecheck`（tsc -b）通过；`bun run lint` 通过；新测试用实测可跑命令执行通过（记录命令）。

## 8. 部署（实现+测试全绿后，单独经用户确认再执行——动生产真金）

1. 提交到 `deploy/manual-qr-topup`（用户确认后），CI 出镜像 `ghcr.io/wuwenrui/new-api:fork-latest`。
2. aliyun CLI：`cd /opt/newapi && docker compose pull new-api && docker compose up -d new-api`。
3. 配置（root 登录站点 系统设置，或 `PUT /api/option/`）:
   - `RechargeNotifyEnabled=true`
   - `RechargeNotifyBarkUrl=https://api.day.app/<device-key>/{{title}}/{{content}}`
   - `RechargeNotifyLinkBase=https://model.codingrui.work`
4. 自测：提交一笔人工充值 → 收到 Bark → 点击直达 `/recharge-review` 定位本单 → 调金额确认 → 用户额度到账。
