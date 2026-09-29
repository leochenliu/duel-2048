# 部署到 Cloudflare

## 选哪条路

| 方案 | 适合 | 代价 |
|---|---|---|
| **A. Workers + Durable Objects**（本项目已实现） | 真正发布出去、发链接给人玩 | 需要 Cloudflare 账号（免费额度足够） |
| **B. Cloudflare Tunnel** | 3 分钟在自己机器上给外部人试玩 | 机器必须开着；不算"发布" |
| **C. 换容器平台**（Railway / Render / Fly） | 已有 Node 服务器、不想改代码 | 要保持实例常驻（内存态对局） |

先说结论：**A 已经写好了**，`src/core/*` 一行都不用改。

## 为什么是 Workers + DO

对局模型要求"**单一写入者**"：两个座位、一条共享事件流、一份过程留痕。
Workers 每个请求的 isolate 互相隔离，只有 **Durable Object** 能同时提供：

- 按 id 路由到唯一实例（一个 `matchId` → 一个 DO）
- 同一实例内请求顺序执行（天然无竞态）
- 状态落盘（实例被回收后能恢复 —— 已实测验证）

`src/core/*.js` 是纯 ESM、只用 `performance`（Workers 原生有），
所以 core 在 Node 和 workerd 两个运行时里跑的是**同一份代码**。

## 一条命令部署

```bash
cd /home/leo/code/0929
npx wrangler login          # 首次：浏览器授权
npx wrangler deploy         # 输出 https://duel-2048.<你的子域>.workers.dev
```

`wrangler.toml` 已经配好：

- `main = worker/index.js`
- `[assets] directory = "./public"` → UI 由 Worker 托管，不需要 Pages
- `run_worker_first = ["/api/*"]` → API 走 Worker，其余走静态资源
- `[[durable_objects.bindings]] MATCH → MatchDO` + `[[migrations]]`

## 本地先验证（不用登录）

```bash
npx wrangler dev            # 起本地 workerd，含 DO 和静态资源
# 打开 http://localhost:8787 跑一遍，OK 再 deploy
```

`npx wrangler deploy --dry-run` 只校验构建，不上线，适合进 CI。

## 线上地址怎么给 Agent

```bash
g2048 new --seed 今天的日期 --pace lock
# → 输出 matchId

export G2048_URL=https://duel-2048.<subdomain>.workers.dev
g2048 join --id <matchId> --seat agent
g2048 board        # 人类在网页左栏同时操作
```

## 本地（Node）与线上的差异

| | Node `src/server/server.js` | Workers |
|---|---|---|
| 对局状态 | 内存（重启丢） | DO storage（重启/回收都在） |
| 并发写入 | 单进程 | DO 串行化 |
| 静态资源 | 手工路由 `/app.js` | `[assets]` 自动 |
| 搜索性能 | depth3 约 3~12ms | 略慢（含 DO 往返），建议 depth 2~3 |
| 单局留痕上限 | 无 | trace 150 条 / events 200 条（防超 128KB） |

## 坑位清单（都已踩过并修掉）

1. **`/static/app.js` 在 Workers 上 404** —— 静态资源按 `public/` 根路径映射。
   现在前端统一用 `/app.js`，两个运行时都能命中。
2. **DO storage 单值 128KB 上限** —— `worker/match-do.js` 里的 `compact()` 裁剪
   trace/events，并把老 move 记录的 `reasoning` 压到 3 条。
3. **SSE 在 Workers 上能用**，但客户端断线后 DO 可能被回收；
   所以每次变更都 `persist()`，靠 EventSource 自动重连兜底（已实测：杀掉 wrangler 重启后对局状态完好）。
4. **不要在 Worker 里用 `node:` 内置模块** —— core 里没有，server.js 有（只跑 Node 端）。
5. **Workers 默认 10ms CPU 限制（免费版实际会给到更高但仍需留意）**：
   `search` 请显式给 `--budget`，别让 expectimax 跑飞。

## 进阶

- **自定义域名**：`npx wrangler deploy` 后在 Cloudflare Dashboard 的
  Workers → Settings → Domains & Routes 里绑定。
- **多局列表 / 历史回放**：把 `POST /new` 的元数据存一份 D1 或 KV。
- **MCP 包装**：把 `worker/match-do.js` 的 `/tool/:seat` 再包一层 MCP server，
  Claude Desktop 等就能原生当 Agent 席 —— core 一行不用改。
