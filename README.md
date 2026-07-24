# grok2api

`grok2api` 是单实例 TypeScript / Node.js 服务，将 xAI Grok CLI 登录态转换为 OpenAI 兼容 API，并提供桌面管理台。

## 功能

- OpenAI Models：`GET /v1/models`
- OpenAI Chat Completions：`POST /v1/chat/completions`
- OpenAI Responses：`POST /v1/responses`
- 流式 SSE、工具调用、reasoning、Prompt Cache 会话键
- SQLite 多账号池：轮询、最少使用、随机、冷却、禁用、过期排除
- API Key 创建、停用、轮换与用量统计
- 账号 JSON 导入导出、单账号/批量测活、模型目录
- OIDC Token 自动续期、SSO 恢复与设备码登录
- Cloudflare Temp Mail 注册、邮箱验证码重登、独立 sing-box 注册代理
- 可恢复的自动化任务、任务日志和管理端操作记录
- MiMo 风格桌面管理台：概览、账号、密钥、模型、设备登录、自动化、用量、日志、设置

项目不提供 Anthropic Messages、CPA、Sub2API、CLIProxyAPI 或外部账号推送功能。

## 运行要求

- Node.js `22.22.x`
- 单实例运行，不支持多副本共享 SQLite
- 生产环境需要持久化 `GROK2API_DATA_DIR`
- 注册功能需要 Cloudflare Temp Mail 与 VLESS 订阅；其余 API 不依赖注册配置

## 本地启动

```powershell
.\start.ps1
```

或直接运行：

```powershell
cd node
npm ci
npm test
npm start
```

默认监听 `http://127.0.0.1:40081`（配置默认 host 为 `0.0.0.0`），管理台位于 `/admin`。

## Docker

```bash
docker compose up -d --build
```

Compose 只启动一个 Node 服务，数据保存在 `grok2api_node_data` SQLite 卷中，不启动 PostgreSQL 或 Redis。

## 必要配置

```env
GROK2API_XAI_UPSTREAM_BASE_URL=https://cli-chat-proxy.grok.com/v1
GROK2API_ADMIN_USERNAME=admin
GROK2API_ADMIN_PASSWORD=change-me
GROK2API_REQUIRE_API_KEY=auto
GROK2API_DEFAULT_MODEL=grok-4.5
GROK2API_ACCOUNT_MODE=round_robin
```

可选注册配置：

```env
GROK2API_CFMAIL_BASE_URL=https://mail.example.com
GROK2API_CFMAIL_API_KEY=change-me
GROK2API_CFMAIL_DOMAIN=example.com
GROK2API_PROXY_SUB_URL=https://example.com/vless-subscription
```

完整变量见 [`node/.env.example`](node/.env.example)。

## 数据与迁移

SQLite 默认路径为 `./data-node/app.sqlite`。Node 进程是唯一写入者，并通过进程锁阻止第二个实例同时打开同一数据目录。

旧数据迁移命令：

```bash
cd node
npm run import:legacy-auth -- ../auth.json
npm run export:legacy-snapshot -- ./legacy-snapshot.json
npm run import:legacy-snapshot -- ./legacy-snapshot.json
```

旧 PostgreSQL 导出仅用于一次性迁移，不是运行时依赖。

## 验证

```bash
cd node
npm test
```

测试覆盖 API Key、账号池、Chat/Responses 流式桥接、SQLite、用量、维护器、设备登录、注册任务、管理 API 和管理台静态资源。

## 目录

```text
node/src/                 Node 运行时
node/public/admin/        桌面管理台
node/test/                Node 回归测试
node/deploy/              单实例 Kubernetes 清单
scripts/                  可选 Python 注册/验证码执行器
grok-build-auth/          xAI 注册与 OAuth 辅助代码
grok2api/                 Python 注册执行器的最小依赖
```

迁移设计和单实例约束见 [`docs/TS_NODE_SINGLE_NODE_MIGRATION.md`](docs/TS_NODE_SINGLE_NODE_MIGRATION.md)。
