# 实现方案

## 1. 架构

```
┌──────────────┐   SSE(/stream)   ┌───────────────────────────┐
│  浏览器 UI    │◀─────────────────│  权威世界 (server.js)      │
│  人类席 渲染  │                  │  ├ match  (双座位/共享流)  │
│  发意图 move  │──POST /tool ────▶│  ├ tools  (Skill 协议)     │
└──────────────┘                  │  └ trace  (过程留痕)        │
                                  └───────────▲───────────────┘
┌──────────────┐  HTTP              ┌─────────┴──────────────┐
│  任意 Agent   │───────────────────▶│  cli/g2048.js          │
│ (pi/claude/  │  board/forecast/   │  语言无关，只做 HTTP    │
│  自写 loop)  │  search/note/move  │                        │
└──────┬───────┘                    └────────────────────────┘
       └── skills/2048-duel/SKILL.md（把上面这套写成 Agent 手册）
```

关键决策：

- **单一写入者。** 服务器是唯一写状态的地方。浏览器和 Agent 都是客户端。
  这样天然避免竞态，也天然让"过程记录"完整（任何一方的每次调用都被记账）。
- **零依赖。** 只用 node: 内置 http / fetch / EventSource。clone 下来直接 `node` 就能跑。
- **工具即协议。** Agent 的"聪明"不是写死在游戏里的，而是它**选择用哪些工具**。
  内置 bot 和外部 LLM agent 走的是完全相同的接口，可对照、可限预算、可做消融实验。
- **搜索按节点预算截断，不用时间截断。** 同样的 (局面, depth, budget) 必然得到同样的结果
  —— 搜索深度就成了可复现、可标定的 handicap 档位。

## 2. 模块

| 文件 | 职责 | 关键约束 |
|---|---|---|
| `core/rng.js` | mulberry32 + 稳定散列 | 整局可复现 |
| `core/stream.js` | 共享事件流、就近落子、预报、置换 | 事件与生成时刻无关，只与消费序号有关 |
| `core/g2048.js` | 规则内核 | 纯函数 + 显式状态；每步存快照用于算分岔点 |
| `core/eval.js` | 评估函数 + expectimax | 纯函数；节点预算；走法排序 |
| `core/match.js` | 双座位、**节奏锁**、挑战事件、分岔点、留痕 | 座位隔离；`lockState/canSeatMove` 是唯一执法点 |
| `core/tools.js` | Skill 协议 | 每个工具都返回"人类可读的摘要"用于 UI；心跳工具不进留痕 |
| `server/server.js` | 权威世界 + SSE（Node 本地） | 变更后广播快照 |
| `worker/index.js` + `worker/match-do.js` | 同一套逻辑的 Workers 部署版 | DO = 单一写入者 + 落盘 + 串行化 |
| `cli/g2048.js` | Agent 席 CLI | HTTP 客户端；`--local` 可完全离线 |
| `bots/heuristic.js` | 内置对手 / 离线基准 | 只用工具，不碰内核 |

## 3. 关键数据结构

```js
match = {
  seed, target, sync, forecastOn, crossSeat,
  stream:   { events: [{ i, value, cell }] },   // 全局唯一，共享
  seats: {
    human: { game: { grid, score, moves, history[], spawned[] }, stats, pendingReasoning[] },
    agent: { ...同上 }
  },
  trace: [ { n, seat, kind: tool|move|note|error, tool, args, ms, summary, data } ],
  divergence: { firstLayout, firstValue, commonSteps, lead },
  lock: { mode, locked, next, humanMoves, agentMoves, humanStatus, agentStatus, reason },
  events: [ ... ],  // 对局级事件流（note / challenge / locked / over）
}
```

`history[]` 存了每一步的盘面快照，于是**分岔点可以在异步对局下精确计算**：
取两边快照的公共前缀，第一个不同的步号就是分岔点。人类和 Agent 进度不同也不影响判定。

### 节奏锁的实现要点

执法点只有一个：`core/match.move()`。CLI、网页、Worker 全部走它，所以不存在旁路。

```js
locked = pace === 'lock' && human.status === 'playing' && agent.moves >= human.moves
```

- 锁住时 `move()` 直接返回 `{moved:false, locked:true, reason}`，**不消耗事件流**（公平性关键）
- 同时压一条 `kind:'locked'` 的 trace + 一条 `pace.locked` 事件，UI 才能把"AI 抢跑"画出来
- 只锁落子：`canSeatMove` 只在 `move` 路径上检查，`board/search/forecast/note` 不受影响

## 4. 协议

```http
POST /api/match                 {seed, target, sync, forecastOn, crossSeat, challenges} → {id, hint}
GET  /api/match/:id             → 完整快照
GET  /api/match/:id/stream      → SSE，event: state，推 snapshot
POST /api/match/:id/tool/:seat  {tool, args} → {ok, tool, ms, result}
GET  /api/match/:id/replay      → {trace, log, divergence}
```

换成 MCP 只是把 `/tool/:seat` 再包一层，core 一行不用改。

## 5. 已实现 / 待办

已实现：
- 共享事件流（strict/value/none）+ 就近落子 + 预报
- **节奏锁（pace: lock/free）**：AI 不领先人类一步，思考不受限，拦截可见
- 双栏 UI（棋盘、统计、过程流、事件流对照表、分岔点仪表、节奏锁仪表、上一步对照）
- Skill 协议 12 个工具（`help/status/turn/board/legal_moves/eval/search/forecast/opponent/note/move/wait`）
- 座位隔离、`crossSeat` 作弊开关
- 挑战事件（`shuffle` 同置换洗牌）
- 离线基准 `bots/heuristic.js --bench`；双席演示 `--both`
- **Cloudflare Workers + Durable Objects 部署**（见 `docs/DEPLOY.md`）
- 19 条测试（规则 / 同步 / 分岔 / 工具 / 确定性 / 节奏锁 8 条）

待办（按优先级）：
1. **replay 时间轴 UI**：双轨回放，每步浮出双方理由（trace 数据已齐，缺 UI）
2. **人类步时 handicap**（现在只做了 AI 算力/信息两轴）
3. **Mirror 模式**：复现对方路径
4. **MCP server 包装**（`src/mcp/`），让 Claude Desktop 等原生接入
5. **GameModule 抽象**：把 2048 的 `grid/moveGrid/applyMove` 抽成接口，迁到 Sokoban / 扫雷
   （锁步与事件流同步这套机制与具体玩法无关，可直接继承）
6. **D1/KV 存历史对局列表**（现在只有内存/单局 DO storage）

## 6. 性能注记

- expectimax depth=3 / budget=20000 单步约 3~12ms（Node 单线程）
- `--depth 4 --budget 40000` 单步可达数百 ms，**离线基准会明显变慢**；
  建议 handicap 档位用 depth 2~3，需要"展示级"算力时再用 4
- SSE 推送整份快照（trace 只保留最近 120 条），4x4 盘面下负载可忽略
