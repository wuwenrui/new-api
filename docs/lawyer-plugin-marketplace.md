# LawyerCopilot 插件市场接口

## 目标

在不改变现有 Skill API 的前提下，为 LawyerCopilot 分发已审核、不可变、签名的 DeepSeek Harness 插件制品。插件权益按模型站用户账号授权，与模型余额分离；令牌可轮换，余额耗尽不影响已购插件下载，停用、过期、IP 限制和封禁仍然生效。

## 用户接口

### `GET /api/marketplace/catalog`

认证：模型站 Bearer Key 或后台登录会话。

服务端按账号过滤可见插件，并返回该账号仍有权使用的全部历史版本，保证客户端能选择兼容版和回滚；客户端依据目录中的 `minHostVersion`、`maxHostVersion`、平台和架构选择版本。目录严格使用 LawyerCopilot catalog schema v1，包含分类、权限、制品大小、SHA-256、Ed25519 签名、两分钟有效期和绝对下载地址，不含制品内容、存储对象键、令牌或临时签名 URL。

### `GET /api/marketplace/plugins/:id/versions/:version/download`

再次执行账号授权，不采信 catalog 缓存。返回不可变 tgz 字节，并在响应头重复给出 SHA-256、签名和签名 Key ID；客户端仍必须用 catalog 与固定公钥独立校验。

## 管理接口

### `POST /api/marketplace/admin/plugins`

管理员发布一个新版本。请求包含插件 ID、npm 包名、兼容版本范围、平台/架构、权限、base64 制品、声明 SHA-256、Ed25519 签名、签名 Key ID 和授权用户列表。

同一 `plugin_id + version` 不可覆盖。重新打包必须发布新版本。服务端限制制品为 32 MiB，并在写库前重新计算 SHA-256。发布准入与客户端使用相同的 ID/SemVer/平台/架构/权限规则；数组必须去重且按字典序排列。服务端使用受信 Ed25519 公钥对最终 canonical metadata 验签，未知 Key、签后字段变化、min/max 倒置均拒绝。默认内置信任 LawyerCopilot 发布公钥；额外公钥只能通过服务端 `MARKETPLACE_SIGNING_PUBLIC_KEYS` JSON 环境变量配置。

### `DELETE /api/marketplace/admin/plugins/:id`

删除插件、全部版本和授权关系。生产操作前应先下架并观察；该接口仅保留管理员紧急清理能力。

## 发布与回滚顺序

1. 服务端先发布增量表和 API；旧客户端与旧 Skill API 不受影响。
2. 上传并授权签名插件制品。
3. LawyerCopilot 客户端更新插件市场能力。
4. 客户端安装失败时只回滚本地 profile；服务端制品保持不可变。
5. 服务端回滚时可停止 catalog 暴露，已安装插件仍由客户端本地版本和权限策略管理。

## 数据库

启动迁移自动新增：`market_plugins`、`market_plugin_versions`、`market_plugin_user_access`。迁移只扩展表，不修改旧表，兼容 SQLite、MySQL 和 PostgreSQL。
