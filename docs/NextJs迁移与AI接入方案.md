# TradeFlow ERP Next.js 迁移与 AI 接入方案

## 目标

把当前 Vue + Vite 前端、Express + SQLite API 的项目逐步迁移到 Next.js App Router，让 Next.js 承担网页入口和同源服务端 API，并通过服务端安全调用 AI。迁移期间继续保留现有 Express API 和 Vue 工作区，避免一次性重写造成订单、库存、权限和备份功能丢失。

## 当前结构

- 前端：Vue 3 + Vite，主要页面集中在 `src/App.vue`。
- 业务 API：Express，位于 `server/index.js`。
- 数据：SQLite，业务库由 `DATA_DIR` 指定；云备份使用 OSS S3 兼容接口。
- 托管：Netlify 当前静态发布；它不能直接承载当前 SQLite 持久化后端。

## 迁移阶段

### 阶段 1：Next.js 服务端基础设施（本次）

- 新建 Next.js App Router 应用入口。
- 交付 Next.js 登录/首次设置入口、基本运营概览和 AI 助手界面。
- Next.js 在 `/api/*` 同源代理现有 ERP API，继续使用现有 HttpOnly 登录会话；兼容工作区作为 iframe 载入，绕开 Vite 开发资源代理问题。
- 添加 `/api/ai/assistant` Route Handler；它仅在服务器读取 AI 提供方配置，校验 TradeFlow 登录会话后再向 OpenAI 兼容接口发请求。
- 保留 Vue ERP 工作区作为 `/classic` 兼容入口，迁移期间可继续操作完整功能。
- 提供迁移文档与服务端环境变量示例。

### 阶段 2：迁移核心业务页面

- 用 React Server/Client Components 增加 Next.js 全局导航与工作空间布局。
- 迁移商品、订单、库存三个高频模块，页面通过同源 Route Handler 读写现有 API。
- 对齐窄屏、错误态、加载态、角色权限和库存/订单状态。

### 阶段 3：按业务逐页迁移

迁移顺序：发货 → 用户权限 → 备份与恢复。每页完成后与旧 Vue 页面核对权限、库存流水、状态变更及错误提示，再将该页从旧工作区隐藏。

### 阶段 4：统一后端

- 把 Express 路由和校验逐步迁移到 Next.js Route Handlers / 服务端业务模块。
- 保持 SQLite 数据文件和表结构，先确保新旧版本兼容，再讨论数据库引擎升级。
- 业务 API 完全迁移且数据操作验证后，才能移除 Express/Vue/Vite 兼容层。

### 阶段 5：生产部署

- 将 Next.js 与持久化 SQLite 部署在同一台自管 ECS（Docker Compose），数据目录挂载独立云盘，Caddy 提供 HTTPS。
- AI 密钥、初始化口令、OSS/RAM 备份配置只进入 ECS 的受限 `.env` / RAM 角色配置；不提交 Git，不使用 `NEXT_PUBLIC_` 前缀。
- Netlify 静态站继续展示旧前端时无法执行 Next.js Route Handlers；要使用新的 Next.js 登录和 AI 功能，应将 Next.js Node 服务部署到 ECS 并将域名指向新站点。
- 部署前备份 SQLite，验证 `/api/health`、登录、AI 错误处理、订单/库存写入和备份恢复。

## AI 安全边界

- AI 供应商配置：`AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY`。`AI_API_KEY` 只由 Next.js Node 服务读取；禁止 `NEXT_PUBLIC_AI_API_KEY`。
- 浏览器只向 TradeFlow 自身 `/api/ai/assistant` 发送问题；密钥不返回给浏览器，也不打印到日志。
- Route Handler 要求有效 TradeFlow 登录会话，限制请求长度和频率（当前为单进程内存计数），向 AI 上游设定超时，并返回经过筛选的文本结果。多实例部署时应改用 Redis 等共享限流存储。
- 当前不会把订单/商品/库存数据传给 AI；只有用户主动提交的问题会送往配置的 AI 服务商。不要在对话中粘贴密码、API Key 或买家隐私信息。
- AI 助手只提供建议；订单、库存等有副作用的动作必须由既有权限控制的业务 API 执行，不能由模型直接执行。
- 服务端代理模型并不能阻止已授权用户滥用 AI 配额。生产环境还应配置提供方额度/速率限制、用户级限额和审计策略。

## 本地运行

需要 Node.js 20.9 或更新版本。`npm run dev:next` 同时启动现有 ERP API（3001）、Next.js（3000）和 Vue/Vite 兼容工作区（5180）；新入口为 `http://localhost:3000`，兼容工作区为 `/classic`。AI 未配置时，ERP 页面仍可使用，AI 路由会返回明确的服务端配置提示。

在 `.env.local` 配置 AI 服务端变量：

```dotenv
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=替换为账户可用的模型名
AI_API_KEY=只保存在服务器的密钥
```

Windows PowerShell 可先运行 `Copy-Item .env.local.example .env.local`，然后只在本机文件中编辑真实模型名和密钥；修改后重启 `npm run dev`。

自托管时另设置 `ERP_API_INTERNAL_URL=http://127.0.0.1:3001`。如果 Next.js 和 Express 不在同一主机/容器网络，改为仅服务端可访问的内部地址。不要把密钥放到聊天、代码、浏览器存储或 GitHub。
