# Skill 市场与图片水印迁移实施计划

**Goal:** 在模型站点提供可用的 Skill 市场、管理员按用户授权和公开图片水印，并准备可核验的一次性数据导入。

**Architecture:** Go/Gin/GORM 增加 Skill 数据和权限接口，React 19 增加 Skill 与水印页面。Skill ZIP 存主数据库，下载接口服务端复核权限；水印完全在浏览器处理。

**Tech Stack:** Go、Gin、GORM、React 19、TanStack Router、Vitest、Canvas、JSZip。

---

## Task 1：Skill 数据与权限

- 新建 `model/skill.go` 和模型测试。
- 注册 `Skill`、`SkillUserAccess` 自动迁移。
- 实现公开、用户可见和管理员全部列表查询；实现事务保存、授权和删除。
- 先写权限与事务失败测试，再实现至通过。

## Task 2：Skill 接口与下载

- 新建 `controller/skill.go`，在 `router/api-router.go` 注册公开、登录用户和管理员接口。
- 支持 ZIP 上传/更新、公开状态、具体用户授权、当前版本下载。
- 下载和详情必须在服务端校验公开状态、管理员身份或用户授权。
- 覆盖匿名、普通用户、获授权用户、管理员和越权请求。

## Task 3：一次性数据导入

- 新建 `cmd/migrate-lawhub-skills/main.go` 和测试样例。
- 读取 lawhub 当前版本 JSON，校验 base64、SHA-256、编号、名称和版本。
- 单事务写入；任一条失败则全部回滚。
- 输出总数、公开/私有数量和逐项哈希，供真实迁移核对。

## Task 4：Skill 市场页面

- 新建 `web/default/src/features/skills/` 的 API、类型、列表和管理员编辑组件。
- 新建 `_authenticated/skills/index.tsx` 路由并接入侧栏。
- 管理员可上传 ZIP、编辑元数据、设公开/私有并勾选具体用户；普通用户只见可访问项。
- 写页面测试覆盖列表、管理员入口和授权提交。

## Task 5：图片水印页面

- 从 lawhub 已验证实现迁移 `types.ts`、`geometry.ts`、`engine.ts`、`archive.ts`、页面组件和样式。
- 新建公开 `/tools/watermark` 路由，并在登录侧栏增加入口。
- 安装 JSZip；迁移几何、Canvas、归档和页面测试。
- 验证图片只在浏览器处理、批量 ZIP 文件名与像素透明度正确。

## Task 6：整体验证

- 运行 Skill 后端相关 Go 测试。
- 运行新增前端测试、类型检查、lint 和生产构建。
- 启动本地模型站点，浏览器验收 Skill 市场和水印批量处理下载。
- 记录迁移核对命令；第一阶段不修改桌面端、不停止 lawhub。
