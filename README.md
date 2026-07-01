# 加密聊天室 · Cloudflare Workers

一个 100% 运行在 [Cloudflare Workers](https://workers.cloudflare.com/) 边缘网络上的实时加密聊天室。基于 [Durable Objects](https://developers.cloudflare.com/durable-objects/) 做房间内连接协调，使用 KV 存储房间元数据，前端为单文件 Telegram 风格界面，支持端到端加密、文件传输、深浅色主题与移动端适配。

> 无需服务器、无需数据库，部署后即得到一个全球可访问的 HTTPS 聊天室。

## 功能特性

- **6 位口令房间**：输入 6 位数字口令即可创建/加入房间，验证码式分格输入。
- **端到端加密**：消息与文件均在浏览器本地用 AES-256-CBC（每条随机 IV）加密，密钥由 PBKDF2 从「口令/密码 + 房间盐」本地派生，服务器只转发密文。设置房间密码后为真端到端（服务器无法解密）。为兼顾响应速度，加密以保密性为主，采用轻量参数。
- **加盐密码哈希**：房间密码经客户端 + 服务端两层 SHA-256 加盐哈希存储，KV 中不留明文。
- **文件传输**：文件加密后分片上传到房间，作为消息卡片展示，任何人（含后加入者）可点击下载，服务器全程只存密文。
- **历史记录**：新加入用户可看到最近 200 条聊天与文件消息。
- **房主管理**：房主可设置/取消房间密码、开关加入、踢人、拉黑、转让房主；房主离开自动顺延给下一位。
- **在线状态**：实时用户列表，掉线超 1 分钟自动移出（心跳保活 + 死连接清扫）。
- **断线重连**：网络抖动/刷新自动重连并恢复会话，房主刷新不丢身份。
- **Telegram 风格 UI**：消息气泡左右分布、按内容自适应宽度，深/浅色主题切换，右上角 Toast 通知，移动端响应式。
- **安全加固**：强制 WSS、HSTS/CSP/X-Frame-Options 等安全响应头、CryptoJS 加载 SRI 完整性校验、密钥指纹显示以核对防中间人。

## 技术栈与项目结构

```
.
├── worker.js       # Worker 入口 + ChatRoom（Durable Object）：路由、连接协调、广播、历史与文件中转
├── index.html      # 单文件前端：UI + 加密 + WebSocket 客户端（内联 CryptoJS via CDN+SRI）
├── wrangler.toml   # Cloudflare 部署配置（DO 绑定、KV 绑定、静态资源导入规则）
└── package.json
```

- **Cloudflare Workers**：边缘运行时，处理 HTTP 与 WebSocket 升级。
- **Durable Objects（ChatRoom）**：每个房间口令映射到唯一实例，同房间所有连接进入同一实例，保证用户列表/消息/文件实时互通。
- **KV（ROOM_KV）**：存储房间设置、盐、密码哈希、黑名单、成员顺序等元数据。

<!-- PLACEHOLDER_APPEND -->

## 部署到 Cloudflare

部署只需要一个 Cloudflare 账号（免费计划即可，Durable Objects 的 SQLite 存储类在免费计划可用）。

### 准备：安装与登录

```bash
# 安装依赖（仅需 wrangler，作为 devDependency 或全局安装均可）
npm install -g wrangler

# 登录 Cloudflare（会打开浏览器授权）
wrangler login
```

> 也可以用 `npx wrangler ...` 而不全局安装。建议 Wrangler 3.30+。

### 第 1 步：创建 KV 命名空间

```bash
wrangler kv namespace create ROOM_KV
wrangler kv namespace create ROOM_KV --preview
```

两条命令会分别输出一个 `id` 和一个 `preview_id`，记录下来。

### 第 2 步：填写 wrangler.toml

把上一步得到的 ID 填入 `wrangler.toml`：

```toml
name = "max-chat-room"            # 可自定义 Worker 名称
main = "worker.js"
compatibility_date = "2026-02-07"

# Durable Object 绑定
[[durable_objects.bindings]]
name = "CHAT_ROOM"
class_name = "ChatRoom"

# DO 迁移：使用 SQLite 存储后端（免费计划可用）
[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatRoom"]

# KV 绑定：填入第 1 步得到的真实 ID
[[kv_namespaces]]
binding = "ROOM_KV"
id = "在此填入 ROOM_KV 的 id"
preview_id = "在此填入 ROOM_KV 的 preview_id"

# 将 index.html 作为文本导入，供 worker.js 中 import HTML from "./index.html"
[[rules]]
type = "Text"
globs = ["**/*.html"]
fallthrough = false
```

### 第 3 步：部署

```bash
wrangler deploy
```

成功后会输出形如 `https://max-chat-room.<你的子域>.workers.dev` 的地址，任意设备打开即可使用（生产环境自动 HTTPS，端到端加密、WSS、安全响应头全部生效）。

### 本地开发

```bash
wrangler dev
```

默认在 `http://localhost:8787` 启动，并自动以本地模拟方式提供 KV 与 Durable Objects。

##微信自定义域名申请恢复访问
你可以在worker.js里的656~660行修改验证文件标题和内容，就能够验证通过

## 安全模型说明

- **真端到端加密**取决于是否设置房间密码：
  - **设置密码后**：加密密钥由「密码 + 盐」本地派生，服务器不知道密码，**无法解密**任何消息/文件。
  - **无密码时**：密钥由「6 位口令 + 盐」派生，服务器知道口令、理论上可推导密钥，等价于「传输层混淆 + 访问控制」。生产环境建议引导房主设置密码。
- 6 位口令本身熵较低，真正的安全强度来自房间密码，请使用足够复杂的密码。
- 文件密文存于 Durable Object 内存中，房间所有人离开后即清空（不持久化存储文件）。
- 本项目为开源演示/自用项目，未经第三方安全审计，请勿用于承载高敏感数据的正式场景。

## 自定义域名（可选）

在 Cloudflare 控制台 → Workers & Pages → 你的 Worker → Settings → Domains & Routes 绑定自有域名即可。

##致谢

Vibe Coding大将军Claude Opus4.8，营中军师写提示词DeepSeek v4Pro，军队Trae（cc太难折腾了），残废主公我自己
原始仓库https://github.com/yeeyrr/Cloudflare-Workers-Chat，我给这个仓库进行二次改写，感谢大佬

## 许可

本项目以 MIT License 开源，欢迎自由使用与二次开发。

