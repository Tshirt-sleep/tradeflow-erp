# TradeFlow ERP · 跨境电商管理

Next.js App Router + Express + Vue 3 + SQLite 的渐进迁移项目。Next.js 是新入口并提供服务端 AI 接口；当前订单、商品、库存、用户与权限 API 暂由 Express 提供，完整 Vue 工作区通过 `/classic` 保留。业务数据保存于 SQLite。

## 本地运行

需要 Node.js 20.19+ 或 22.12+。

```bash
npm install
npm run dev
```

`npm run dev` 会启动 Next.js、旧 Vue/Vite 工作区和 Express API。打开 `http://127.0.0.1:3000`；Next.js 入口可进入 `/classic` 使用完整旧工作区；业务健康检查为 `http://127.0.0.1:3000/api/health`。复制 `.env.local.example` 为 `.env.local`，在其中填写 AI 服务端变量 `AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY`。AI 密钥不得使用 `NEXT_PUBLIC_` 前缀、写入浏览器或提交 Git。Next.js 只会在服务器端验证会话并请求 AI 服务。

首次访问时创建管理员账号，密码至少 12 位。生产环境创建首个管理员还需要 `TRADEFLOW_SETUP_TOKEN`：先在服务器 `.env` 设置至少 32 位随机口令；创建首个账号后初始化接口会关闭。可在本机用 `openssl rand -base64 48` 生成，切勿提交到代码仓库或发在聊天里。

本地开发初次启动会在 `data/tradeflow.sqlite` 创建数据库和虚构示例数据。生产环境默认只创建空数据库，不会混入演示订单；仅在专用演示环境显式设置 `TRADEFLOW_SEED_DEMO_DATA=true` 才初始化示例数据。账号、商品、订单和库存状态均持久保存。

## Netlify 前端部署

Netlify 现在使用 `npm run build:demo` 发布无需后端的浏览器演示版。它会绕过登录和所有服务端 API，将商品、订单、库存流水保存在浏览器 `localStorage`，并支持导出/恢复演示快照。数据不会上传，也不会跨浏览器、设备或用户同步；清除网站数据可能导致演示数据丢失。请勿把此演示版用于真实业务。

本机单独启动演示版可运行 `npm run dev:demo`，访问 Vite 输出的本机地址，无需启动 Express 或 Next.js。

全栈版仍可用 `npm run build:legacy` 构建 Vue 静态前端，并通过 Netlify Function 代理到独立 Express/SQLite 后端；Next.js Route Handlers 与服务端 AI 助手则需运行在 Next.js Node 服务中。部署选择和 AI 密钥配置见[Next.js 迁移与 AI 接入方案](docs/NextJs迁移与AI接入方案.md)。

## 用户与权限

- **管理员**：管理用户、商品和库存调整，并执行全部订单操作。
- **运营**：确认/取消订单、发货和完成订单。
- **只读**：查看业务数据。

密码使用 scrypt 哈希保存；登录 cookie 为 HttpOnly / SameSite=Lax，12 小时过期。管理员在“用户与权限”中创建账户、调整角色或停用账号。

订单确认、取消、发货、完成和平台订单导入会记录操作者与时间；库存调整和商品期初库存也会记录操作账号，订单详情和库存流水可查看相关记录。

## 库存履约

确认订单时，服务端按可用库存原子预占；取消待发货订单会释放预占；发货时扣减现有库存和预占量并写流水；已发货订单可标记为已完成。管理员可按盘点、入库或损耗原因登记库存调整，不能把现有库存调到预占量以下；只读账号无调整权限。库存流水记录人工调整的原因和操作人。库存页显示现有、预占、可用数和最近变更流水。

运行 API 回归检查：

```bash
npm test
```

该检查在系统临时目录建立隔离数据库，不会修改项目的 `data/tradeflow.sqlite`。

## 备份与恢复

- SQLite 数据库在首次启动时自动创建一份启动备份，之后每 24 小时生成自动备份；本机最多保留 30 份。
- 管理员可从“备份管理”手动创建、下载和恢复快照，也可列出 OSS 云端快照并直接恢复。恢复前系统自动创建本机安全副本，校验 SQLite 完整性和应用数据表，应用兼容迁移，并在恢复后撤销所有登录会话。
- OSS 上传失败时本机快照继续保留；系统每 30 分钟自动补传，管理员也可在“备份管理”手动重试，页面显示待同步数量。
- 可配置 AWS S3、Cloudflare R2 或其他 S3 兼容对象存储同步异地副本。复制 `.env.example` 为 `.env` 并填写 bucket、region/endpoint 和访问凭据。`.env` 已被 Git 忽略，切勿提交密钥。配置后新建的本地备份会尝试上传；页面分别显示本地和异地状态。
- 阿里云 ECS 可配置 OSS S3 兼容 Endpoint，并使用实例 RAM 角色自动获取/刷新临时凭据；该 RAM 角色需限制到备份前缀，并具备列举、读取和写入快照的权限；部署参数见[阿里云部署与备份](docs/阿里云部署与备份.md)。
- 为云端 bucket 配置访问最小权限、传输/静态加密和生命周期规则。远端对象保留策略由 bucket 生命周期管理。

## 容器部署

Docker Compose 将数据库持久化到 `tradeflow-data` 命名卷。普通本地容器模式由 Express 提供旧页面和 API；云端 `cloud` profile 启动 Next.js、Express/SQLite 和 Caddy，Caddy 将请求交给 Next.js，Next.js 再代理旧业务 API。默认业务端口只绑定到本机回环地址，公网仅开放 80/443。

阿里云部署脚本使用 `--profile cloud` 启动 Caddy HTTPS 入口。启动前将 `.env` 的 `TRADEFLOW_DOMAIN` 改成解析到 ECS 的真实域名、设 `TRUST_PROXY_HOPS=1`（应用只信任唯一一层 Caddy 代理），并开放安全组 80/443；本地开发默认不启动这个云端入口且代理信任保持为 0。

```bash
docker compose up -d --build
docker compose logs -f tradeflow
```

部署前先配置 `.env` 中的 S3 兼容异地备份变量，确认云主机有持久化卷和定期快照。执行容器发布前需在目标机器验证 Docker、域名、TLS 反向代理、持久卷和云账号设置。本项目没有自动创建云资源。

## 项目文档

[全栈升级步骤](docs/全栈升级步骤.md) 记录业务模型、API、权限、备份与后续集成阶段。

[阿里云上线参数表](docs/阿里云上线参数表.md) 列出创建云资源前需要确定的地域、域名、预算和 SSH 来源；[阿里云部署与备份](docs/阿里云部署与备份.md) 提供服务器部署和恢复步骤，并说明已验证的 Terraform 草案如何审阅。

## 当前边界

本项目包含基础账号权限和可配置异地备份，但尚未部署到云端，也没有 PostgreSQL、多因素认证和密码找回。发货时由操作人员手动填写承运商和追踪号；系统不自动获取物流轨迹，也不购买邮资、创建寄件或打印面单。开始处理真实业务前，还要配置生产 HTTPS/访问策略、完成恢复演练和安全审计。
