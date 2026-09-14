# LawyerDesk 计费与人工充值发行记录

## 发布范围

本次以自有 `origin/main` 为唯一发布源，加入模型令牌只读计费元数据及受限人工充值申请接口。网站和插件共用核价、待处理 TopUp 创建、原通知与管理员处理流程；不增加第二套账本、不改数据库结构，不自动付款或入账。

发布预检基线：自有 main `6285331b6`；上游 QuantumNous/new-api main `9fe0457ee`。上游存在119个自有 main 未包含的提交。无工作区修改的 `git merge-tree --write-tree --name-only --no-messages` 预检返回278个冲突路径，其中55个后端/根路径、223个前端路径，包含鉴权、用户模型、计费及前端迁移。

用户已明确选择“仅发布充值功能，暂缓上游同步”。因此本次不引入上述上游批次，不把该例外表述为上游已经同步，也不自行解决大规模迁移冲突。后续上游同步仍需独立裁决与验收。

## 发行门禁

- `web/` 执行 `bun install --frozen-lockfile`；default 类型检查及 default/classic 两套实际生产构建通过。
- 清除 `SQL_DSN`、`LOG_SQL_DSN`、`REDIS_CONN_STRING` 后，`go build ./...` 完整通过，不使用占位静态资产。
- `go test ./controller ./service ./middleware ./router ./model -count=1` 完整通过，并显式设置 `LAWYER_BILLING_CONSUMER_DIR` 执行真实 JavaScript → Gin/SQLite 跨仓契约测试。
- 共享创建/报价兼容、所有者与状态/IP/过期鉴权、仅申请不入账、仅状态成功不推断余额、重复管理员处理只入账一次及限流桶隔离有测试证据。

## 部署和验收约束

GitHub `Build Image` 从合入的 main 提交构建，同时产生提交 SHA 标签和 `fork-latest`。生产部署前必须核对该提交的成功构建、记录旧镜像身份与 Compose 指纹，按云账号门禁确认具体命令。不得从本任务侧分支直接部署。

保持数据库、缓存与共享边缘配置不变；为重启期间的既有自动迁移保留数据库备份和旧镜像。部署后分别核验容器健康、容器内部 HTTP、边缘 TLS 路由与公网正常 TLS，再检查本次接口授权边界。没有真实充值订单、真实付款或真实 Bark 验证；这些不得通过自动化验收擅自创建。

正式镜像提交、部署结果和线上证据由发行操作记录追加；此文档的构建通过不代表已经部署。完整产品/桌面发行证据另由 LawyerDesk 发布记录维护。
