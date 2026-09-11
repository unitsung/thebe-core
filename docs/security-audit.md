# Thebe Core 代码安全与工程质量审计报告（修正版）

> 基于 `dev` 分支源码逐文件核实，2026-09-11  
> 审计范围：`src/http/`、`src/product/`、`src/auth/`、`src/config/env.ts`  
> 结论格式：🔴 高优先级问题 · 🟡 中优先级问题 · 🟢 正面实现 · ℹ️ 信息补充

---

## 执行摘要

Thebe Core 的整体设计理念清晰，核心运行时边界、只读工具层、双重 redaction 和 fail‑fast 配置检查都在合理位置。  
**这套代码不是"安全摆设"**，但它是 **homelab‑first** 的部署模型——默认监听全部网卡、token 鉴权可选、无速率限制，只要部署者未主动配置，入口保护就会弱到只剩浏览器层面的跨站防护。  
以下将每个问题按出处逐行说明，方便直接对照改动。

---

## 一、入口鉴权层（核心风险）

### 🔴 THEBE_TOKEN 非强制，未设置时鉴权整体跳过

**文件**：`src/product/bootstrap.ts`、`src/product/app.ts`、`src/http/handler.ts`

```typescript
// bootstrap.ts L91
const app = createThebeApp({
  ...
  token: process.env.THEBE_TOKEN,   // ← 环境变量不存在时传入 undefined
  ...
});

// app.ts L31
const handler = createThebeHttpHandler({
  token: options.token,             // ← undefined 直接往下传
  ...
});

// handler.ts L21
const token = options.token?.trim() || undefined;
// ...
if (token) {           // ← token 为 undefined 时整段 if 被跳过，无任何鉴权
  const got = request.headers.get("X-Thebe-Token") ?? "";
  if (got !== token) {
    return json({ ok: false }, 401);
  }
}
```

**对比**：Arcane 配置有 `requireArcane` guard，会调用 `failEnv()` 强制退出；`THEBE_TOKEN` 没有对等机制。  
**影响**：未配置 token 时，所有路由（包括 `/v1/system/quiesce`、`/v1/auth/*`、`/mcp`）均无应用层鉴权保护。  
**建议**：在 `serve.ts` 或 `bootstrapThebe` 中增加类似 Arcane 的生产模式保护：

```typescript
// 建议改动，serve.ts
const token = process.env.THEBE_TOKEN?.trim();
if (!token && process.env.NODE_ENV === "production") {
  console.error("THEBE_TOKEN is required in production. Set it in .env.local or environment.");
  process.exit(1);
}
```

---

### 🔴 默认监听 0.0.0.0，但日志显示 127.0.0.1，存在误导

**文件**：`src/http/serve.ts`、`src/http/listen.ts`

```typescript
// serve.ts L9–10
const port = Number(process.env.THEBE_PORT ?? "8787");
const host = process.env.THEBE_HOST ?? "0.0.0.0";   // ← 实际 bind 全部网卡

// listen.ts L24–26
const urlHost = host === "0.0.0.0" ? "127.0.0.1" : host;
return { server, url: `http://${urlHost}:${bound}` };
// ↑ 日志打印的是 127.0.0.1，但服务实际接受所有 NIC 的连接
```

**影响**：部署者看到 `THEBE_LISTEN http://127.0.0.1:8787` 可能误以为服务只在本机可访问，但局域网内所有设备实际都能访问。结合 token 未配置的场景，这是一个组合型误导风险。  
**建议**：日志同时打印 bind 地址和展示 URL，或者直接改默认值为 `127.0.0.1`：

```typescript
// 建议改动，serve.ts
const host = process.env.THEBE_HOST ?? "127.0.0.1";  // 更安全的默认值
```

---

### 🟡 /v1/system/quiesce 无角色隔离，依赖 token 作为唯一防线

**文件**：`src/http/handler.ts`

```typescript
// handler.ts L55–63
if (request.method === "POST" && path === "/v1/system/quiesce") {
  if (!options.product) {
    return json({ ok: false, error: "product service unavailable" }, 503);
  }
  await options.product.quiesce();       // ← 仅依赖上方 token 校验，无额外控制
  return json({ ok: true, status: "quiesced" });
}
```

**影响**：任何持有 token（或 token 未配置时任何人）都可以触发 quiesce/unquiesce。对 homelab 单用户无实际问题，但若未来多客户端共用同一实例会有干扰风险。  
**建议**：homelab 阶段可接受现状，但应在文档中标注"该操作等同于管理员权限"，未来扩展时加角色区分。

---

## 二、浏览器安全层（条件性风险）

### 🟡 GET 请求完全绕过 validateRequestSecurity

**文件**：`src/http/security.ts`

```typescript
// security.ts L5–7
const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
if (!isMutating) {
  return { ok: true };    // ← 所有 GET 请求无条件通过
}
```

**当前影响**：`/v1/session` 列表和 `/v1/session/:id/export` 是实质性数据端点，只要 token 不配置，对任何能访问到 host 的人都是开放的。  
**建议**：token 鉴权已在 handler.ts 前置，此处可接受；但需在代码注释中明确"GET 路由的安全由 token 层兜底，security.ts 只负责跨站防护"。

---

### 🟡 Origin 缺失时 mutating 请求不做跨域检查

**文件**：`src/http/security.ts`

```typescript
// security.ts L19–29
const origin = request.headers.get("origin");
const host = request.headers.get("host");
if (origin && host) {   // ← origin 为空时（curl/iOS 客户端）整段跳过
  // ...cross-origin check
}
```

**评价**：这是设计决策，不是 bug。iOS 客户端、curl、Tauri 等非浏览器场景不会发送 `origin` 头，`sec-fetch-site: cross-site` 已经可以拦截浏览器跨站请求，是合理的兼容方案。  
**建议**：在 `security.ts` 顶部加注释说明设计意图：

```typescript
/**
 * Security check for mutating requests.
 * Non-browser clients (curl, iOS, Tauri) do not send Origin headers — we
 * intentionally skip origin validation when Origin is absent.
 * Browser cross-site requests are blocked via sec-fetch-site first.
 * Application-level token auth (handler.ts) is the primary guard.
 */
```

---

## 三、路由层问题

### 🟡 /mcp 端点 callTool 未校验 name 白名单，任意工具名可被调用

**文件**：`src/http/routes/mcp.ts`

```typescript
// mcp.ts L42–50
async function callTool(product, name, args) {
  if (MCP_EVENT_TOOLS.includes(name)) { ... }
  const mapped = ALIASES[name] ?? name;   // ← 不在枚举范围内时直接以原始 name 调用
  if (!product) { throw ... }
  return product.invokeTool(mapped, asObject(args) ?? {});
}
```

**影响**：调用方传入不在枚举列表里的 `name` 不会被提前拒绝，而是直接调用 `product.invokeTool`，相当于 MCP 端点是对所有内部注册工具的开放代理。  
**建议**：加前置白名单校验：

```typescript
const ALL_TOOL_NAMES = new Set([
  ...CONTAINER_TOOL_NAMES,
  ...MCP_EVENT_TOOLS,
  ...Object.keys(ALIASES),
]);
if (!ALL_TOOL_NAMES.has(name)) {
  throw new Error(`unknown tool: ${name}`);
}
```

---

### 🟡 /v1/session/:id/export 返回 HTML 缺少 CSP 头

**文件**：`src/http/routes/session.ts`

```typescript
// session.ts L189–195
if (format === "html") {
  return new Response(exported.html, {
    headers: {
      "content-type": "text/html",
      "content-disposition": `attachment; filename="session-${id}.html"`,
      "x-content-type-options": "nosniff",
      // ← 没有 Content-Security-Policy 头
    },
  });
}
```

**影响**：导出的 HTML 若包含用户输入内容（如 agent 回复中含 `<script>` 或 `<img onerror>`），浏览器直接打开时有存储型 XSS 风险。  
**建议**：

```typescript
"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
```

---

### 🟡 permission 端点 response 字段默认 allow，格式错误不拒绝

**文件**：`src/http/routes/session.ts`

```typescript
// session.ts L137–143
const response = body.response === "deny" ? "deny" : "allow";
// ↑ 任何非 "deny" 值（包括 null、undefined、格式错误）都静默映射为 "allow"
```

**影响**：格式错误的请求不会被拒绝，而是静默地批准权限。  
**建议**：改为严格白名单校验：

```typescript
const response = body.response === "deny" ? "deny"
  : body.response === "allow" ? "allow"
  : null;
if (!response) {
  return json({ ok: false, error: "response must be 'allow' or 'deny'" }, 400);
}
```

---

### ℹ️ /v1/devices 是空壳端点，当前无副作用

```typescript
// handler.ts L37
if (request.method === "POST" && path === "/v1/devices") {
  return json({ ok: true });    // ← 无 body 读取，无持久化，无副作用
}
```

**建议**：标注 `// TODO: validate and persist device registration` 防止未来扩展时忘记加验证。

---

## 四、SSE 流与资源管理

### 🟡 sessionLogStream 无连接数限制和空闲超时

**文件**：`src/http/parse.ts`

```typescript
// parse.ts sessionLogStream
const unsub = product.subscribeLog(thebeSessionId, send);
// ← 没有最大连接数计数
// ← 没有空闲超时（只依赖 request.signal.aborted，客户端主动断开才释放）
request.signal.addEventListener("abort", close, { once: true });
```

**影响**：客户端后台挂起（iOS、浏览器 tab 冻结）时 `subscribeLog` 订阅永不释放，逐渐累积内存和事件监听器。  
**建议**：加入空闲超时：

```typescript
const MAX_IDLE_MS = 5 * 60 * 1000; // 5 分钟无新事件自动关闭
let idleTimer = setTimeout(close, MAX_IDLE_MS);
const send = (event) => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(close, MAX_IDLE_MS);
  // ...原有逻辑
};
```

---

## 五、环境变量与配置加载

### 🟡 env.ts 向上遍历 8 层目录，路径范围过宽

**文件**：`src/config/env.ts`

```typescript
// env.ts L36
for (let i = 0; i < 8; i++) {   // ← 最多向上遍历 8 层，从 3 个起始目录出发
  out.push(join(dir, ".env.local"));
  // ...
}
```

**影响**：实际尝试约 24 个候选路径。若项目部署在深层目录，可能会意外读取 `~/.env.local` 甚至更上层的配置文件，静默注入非预期的环境变量。  
**建议**：减少搜索层数至 3–4 层，或在读取时打印已加载的路径供调试：

```typescript
for (let i = 0; i < 4; i++) {  // 覆盖 src/ → dist/ → 根目录已足够
```

---

### 🟢 已有配置不覆盖（优先级正确）

```typescript
// env.ts L55
if (process.env[key] === undefined) {
  process.env[key] = value;    // ← 只在 key 不存在时才注入，容器/系统环境变量优先
}
```

容器注入的环境变量 > `.env.local`，优先级模型正确。

---

## 六、认证与密钥管理

### 🟢 Thebe 层不持久化 API Key，生命周期在 runtime 侧

**文件**：`src/auth/credentials.ts`

```typescript
export async function applyThebeApiKey(auth, providerId, apiKey) {
  await auth.setApiKey(providerId, apiKey);  // ← 只是透传，不在 Thebe 层落盘
}
// 注释："Thebe does not store or refresh OAuth tokens."
```

减少了 Thebe 层的密钥泄露面，是清晰的边界划分。

---

### 🟡 PUT /v1/auth/:providerId 接受明文 API Key，无 TLS 强制

**文件**：`src/http/routes/product-api.ts`

```typescript
// product-api.ts L69–77
if (request.method === "PUT" && parts[1] === "auth" && parts[2]) {
  const body = await readJson(request);
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  await product.auth().setApiKey(parts[2], apiKey);
  return json({ ok: true });
}
```

**影响**：当前 HTTP 服务不强制 TLS，API key 在局域网内以明文传输。  
**建议**：文档中标注"生产环境建议通过 Tailscale 或 HTTPS 反向代理保护此端点"。

---

## 七、工具层与审计

### 🟢 PolicyEngine + wrapCustomTools 是安全设计最扎实的模块

**文件**：`src/product/wrap-tools.ts`

- **fail‑closed**：`decision.block` 为真时返回 deny，被拦截的调用仍写入 audit log，不静默跳过
- **watchdog timeout**：`Promise.race([executePromise, timeoutPromise])` 防止工具挂死阻塞 agent 循环，触发时发出 `tool_watchdog_timeout` 事件
- **双重 redaction**：tool output 和 error message 都经过 `redactToolOutput` 处理
- **prompt injection 防护**：`wrapResult` 用 `<tool_output tool="...">` XML 标签隔离工具输出，防止内容被模型误解为系统提示

---

## 八、parse.ts 输入验证（正面评价）

**文件**：`src/http/parse.ts`

| 校验项 | 实现 |
|--------|------|
| message limit 上限 | `MAX_MESSAGE_LIMIT = 500`，超出截断 |
| 文件数量上限 | `MAX_PROMPT_FILES` 枚举检查 |
| 文件大小上限 | `MAX_PROMPT_FILE_BYTES`，超出返回 413 |
| 文件类型白名单 | `isSupportedPromptFile(mediaType)` 校验 |
| inline 超大文件降级 | 超 `MAX_INLINE_FILE_BYTES` 自动降为 reference 模式 |
| SSE cursor 格式 | 强制非负整数，非法值 400 |

这是整个代码库中输入边界处理最认真的模块之一。

---

## 九、优先级总表

| 优先级 | 问题 | 文件 | 改动难度 |
|--------|------|------|----------|
| 🔴 P0 | THEBE_TOKEN 非强制，未设置时鉴权整体跳过 | `bootstrap.ts`, `serve.ts` | 小（5 行） |
| 🔴 P0 | 默认 0.0.0.0 监听 + 日志显示 127.0.0.1 误导 | `serve.ts`, `listen.ts` | 小（改默认值） |
| 🟡 P1 | permission 端点 response 字段默认 allow | `routes/session.ts` | 小 |
| 🟡 P1 | MCP callTool 未校验 name 白名单 | `routes/mcp.ts` | 小 |
| 🟡 P1 | export HTML 缺少 CSP 头 | `routes/session.ts` | 小 |
| 🟡 P1 | SSE sessionLogStream 无空闲超时 | `parse.ts` | 中 |
| 🟡 P2 | /v1/auth PUT 明文传输 API key，需文档说明 TLS | `routes/product-api.ts` | 文档 |
| 🟡 P2 | env.ts 向上遍历 8 层路径范围过宽 | `config/env.ts` | 小 |
| 🟡 P2 | /v1/system/quiesce 无角色隔离 | `handler.ts` | 中（需文档先行） |
| ℹ️ 信息 | /v1/devices 是空壳端点 | `handler.ts` | 加注释即可 |
| ℹ️ 信息 | GET 路由绕过 security.ts 是设计决策 | `security.ts` | 加注释即可 |

---

## 十、总体结论

**当前安全级别**：适合单用户 homelab、通过 Tailscale 或防火墙隔离的内网部署。

**不适合的场景**（未做额外加固时）：
- 将 `THEBE_HOST` 保持为 `0.0.0.0` 并暴露到公网
- 不配置 `THEBE_TOKEN` 并允许不可信设备访问局域网
- 多用户共享同一实例

**立即可做的两件事**（改动各 < 10 行）：
1. `serve.ts`：生产模式强制要求 `THEBE_TOKEN` 非空
2. `serve.ts`：将默认 `THEBE_HOST` 改为 `127.0.0.1`
