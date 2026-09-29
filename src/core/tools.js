// 工具层（Skill Protocol）
// ---------------------------------------------------------------
// AI 侧不直接改状态，只能通过这一组工具"看"和"动"。
// Agent 的自由 = 选择哪些工具、什么顺序、看多深 —— 这就是"过程"的来源。
// 人���侧也走同一套工具（只是不会用 search），保证两侧记录格式一致、可对照。
import { view, DIRS, DIR_KEYS, canMove, moveGrid } from './g2048.js'
import { evaluate, scoreMoves, search } from './eval.js'
import { forecast } from './stream.js'
import { move, trace, pushEvent, lockState, canSeatMove } from './match.js'

const T = (g) => {
  const rows = []
  for (let r = 0; r < 4; r++) rows.push(g.slice(r * 4, r * 4 + 4).map((v) => (v === 0 ? '.' : String(v))).join(' '))
  return rows.join('\n')
}

const cells = (g) => g.map((v, i) => (v ? `${i}=${v}` : null)).filter(Boolean).join(' ')

const TOOLS = {
  help: {
    desc: '列出全部工具与参数。不消耗任何状态。',
    args: {},
    run: () => ({
      catalog: Object.entries(TOOLS).map(([name, t]) => ({ name, desc: t.desc, args: t.args })),
      protocol: [
        '每回合的标准节奏：turn（确认能不能走）→ board → legal_moves 或 search → note → move <dir>',
        'note "<一句话>" 用来把你的判断写进右栏的过程面板（强烈建议每步都写）',
        'forecast 看到的是共享事件流：人类和你面对的是同一批方块',
        '节奏锁：锁步模式下 locked=true 时 move 会被拒绝（不消耗事件、不算失败）',
        '  但 board / forecast / search / note 不受限 —— 被锁时也请把思考写下来，这正是人类要看的过程',
        '  正确做法：先 turn 确认轮到自己，再一次性完成 board→search→note→move',
        '禁止直接猜答案：所有认知必须来自工具返回',
      ],
    }),
  },

  status: {
    desc: '对局状态：双方分数/步数/最高方块/是否结束/已分岔到第几步/节奏锁状态。',
    args: {},
    run: (ctx) => ({
      step: ctx.match.step,
      target: ctx.match.target,
      divergence: ctx.match.divergence,
      lock: lockState(ctx.match),
      youCanMove: canSeatMove(ctx.match, ctx.seat),
      over: ctx.match.over,
      winner: ctx.match.winner,
      seats: Object.fromEntries(
        Object.entries(ctx.match.seats).map(([k, v]) => [k, {
          moves: v.game.moves, score: v.game.score, maxTile: v.game.maxTile, status: v.game.status,
          toolCalls: v.stats.toolCalls, readMs: Math.round(v.stats.readMs), polls: v.stats.polls, waitMs: Math.round(v.stats.waitMs),
        }])),
    }),
  },

  turn: {
    desc: '节奏锁：返回 {mode, locked, next, youCanMove, reason}。locked=true 时 move 会被拒绝，但思考类工具照常可用。',
    args: {},
    run: (ctx) => ({ ...lockState(ctx.match), seat: ctx.seat, youCanMove: canSeatMove(ctx.match, ctx.seat) }),
  },

  board: {
    desc: '读取本座位的棋盘（4x4）、分数、步数、最高方块、已落子次数。',
    args: {},
    run: (ctx) => ({ view: view(ctx.game), ascii: T(ctx.game.grid), cells: cells(ctx.game.grid) }),
  },

  legal_moves: {
    desc: '枚举 4 个方向的合法性 + 一步之后的启发式分（便宜的信息读取）。',
    args: {},
    run: (ctx) => {
      const cands = scoreMoves(ctx.game.grid).map((c) => ({ dir: c.dir, moved: c.moved, eval: Math.round(c.score) }))
      return { legal: cands.filter((c) => c.moved).map((c) => c.dir), candidates: cands, ascii: T(ctx.game.grid) }
    },
  },

  eval: {
    desc: '对当前局面打分（空格/单调/平滑/蛇形/角落）。用于自评局面好坏。',
    args: {},
    run: (ctx) => ({ score: Math.round(evaluate(ctx.game.grid)), empties: ctx.game.grid.filter((v) => !v).length }),
  },

  search: {
    desc: '期望极大搜索：depth=层数(1-4)，budget=节点预算(算力额度)。返回最佳方向、各方向分数、主变。',
    args: { depth: 3, budget: 20000 },
    run: (ctx, args) => {
      const depth = Math.max(1, Math.min(4, Number(args.depth ?? 3)))
      const budget = Math.max(200, Math.min(200000, Number(args.budget ?? 20000)))
      const r = search(ctx.game.grid, { depth, budget })
      return { best: r.dir, scores: r.scores, pv: r.pv, nodes: r.nodes, depth, budget, eval: Math.round(r.score) }
    },
  },

  forecast: {
    desc: '预告共享事件流接下来 n 条（{value, cell}）。两侧完全相同 —— 这就是"同样的上下文"。',
    args: { n: 3 },
    run: (ctx, args) => {
      if (!ctx.match.forecastOn) return { on: false, events: [] }
      const n = Math.max(1, Math.min(10, Number(args.n ?? 3)))
      return { on: true, events: forecast(ctx.match.stream, ctx.game.spawnIndex, n) }
    },
  },

  opponent: {
    desc: '读取对手棋盘。只有 match.crossSeat=true 时可用（作弊/教学模式）。',
    args: {},
    run: (ctx) => {
      if (!ctx.match.crossSeat) return { on: false, reason: 'crossSeat 关闭：座位隔离已生效' }
      const other = ctx.seat === 'human' ? 'agent' : 'human'
      const g = ctx.match.seats[other].game
      return { on: true, seat: other, ascii: T(g.grid), view: view(g) }
    },
  },

  note: {
    desc: '写一句你的思考/策略，会实时显示在右栏过程面板。args.text',
    args: { text: '' },
    run: (ctx, args) => {
      const text = String(args.text ?? '').slice(0, 400)
      if (!text.trim()) return { ok: false }
      ctx.match.seats[ctx.seat].stats.notes += 1
      pushEvent(ctx.match, 'note', { seat: ctx.seat, text })
      return { ok: true, text }
    },
  },

  move: {
    desc: '走一步：args.dir ∈ up|down|left|right（也接受 w/a/s/d）。锁步模式下必须等人类先走。消耗一次共享事件。',
    args: { dir: 'left' },
    run: (ctx, args) => {
      const raw = String(args.dir ?? '').toLowerCase().trim()
      const dir = DIR_KEYS[raw]
      if (!dir) return { ok: false, error: `未知方向：${raw}` }
      // 节奏锁的判定与留痕统一在 core/match.move 里（唯一执法点）
      const r = move(ctx.match, ctx.seat, dir)
      if (r.locked) {
        const L = lockState(ctx.match)
        return { ok: false, locked: true, reason: L.reason, next: L.next, hint: '先 note 一句你此刻在想什么（思考不受锁），再 turn 确认轮到自己' }
      }
      return { ok: r.moved, ...r }
    },
  },

  wait: {
    desc: '什么都不做，只留下一条过程记录（用于"我在思考/我在等对手"的显式表达）。',
    args: { ms: 300 },
    run: async (ctx, args) => {
      const ms = Math.max(0, Math.min(20000, Number(args.ms ?? 300)))
      await new Promise((r) => setTimeout(r, ms))
      ctx.match.seats[ctx.seat].stats.thinkMs += ms
      return { waited: ms }
    },
  },}

export const TOOL_NAMES = Object.keys(TOOLS)

/** 统一入口：所有工具调用都会留痕（Agent 过程面板的数据源） */
export async function runTool(match, seat, tool, args = {}, { log = true } = {}) {
  const def = TOOLS[tool]
  if (!def) {
    const err = `未知工具 ${tool}；可用：${TOOL_NAMES.join(', ')}`
    if (log) trace(match, seat, { tool, args, ok: false, ms: 0, summary: err, kind: 'error' })
    return { ok: false, error: err }
  }
  const t0 = performance.now()
  let result
  try {
    result = await def.run({ match, seat, game: match.seats[seat].game, args }, args)
  } catch (e) {
    const ms = Math.round(performance.now() - t0)
    if (log) trace(match, seat, { tool, args, ok: false, ms, summary: `异常：${e.message}`, kind: 'error' })
    return { ok: false, error: e.message }
  }
  const ms = Math.round((performance.now() - t0) * 10) / 10
  if (log && !SILENT.has(tool)) {
    trace(match, seat, { tool, args, ok: result?.ok !== false, ms, summary: summarize(tool, result), data: slim(tool, result) })
  } else if (log && SILENT.has(tool)) {
    // 心跳类调用：只计次数，不进过程流（否则轮询会把留痕刷爆）
    match.seats[seat].stats.polls += 1
  }
  return { ok: true, tool, ms, result }
}

// 不进过程留痕的工具：走子由 core 自己留痕；turn/wait 是心跳
const SILENT = new Set(['move', 'turn', 'wait', 'help'])

function summarize(tool, r) {
  switch (tool) {
    case 'note': return r?.text || ''
    case 'legal_moves': return (r?.candidates || []).map((c) => `${c.dir}:${c.moved ? Math.round(c.eval) : 'x'}`).join('  ')
    case 'search': return `best=${r?.best}  ${(r?.scores || []).map((s) => `${s.dir}:${s.score}`).join(' ')}  nodes=${r?.nodes}`
    case 'forecast': return (r?.events || []).map((e) => `${e.value}@${e.cell}`).join(' ')
    case 'eval': return `eval=${r?.score} empty=${r?.empties}`
    case 'opponent': return r?.on ? r.ascii.split('\n')[0] : '隔离中'
    case 'wait': return `等待 ${r?.waited}ms`
    case 'turn': return `${r?.locked ? '🔒' : '▶'} ${r?.reason}`
    case 'help': return `${(r?.catalog || []).length} 个工具`
    default: return ''
  }
}

function slim(tool, r) {
  if (!r) return {}
  if (tool === 'turn') return r
  if (tool === 'board') return { ascii: r.ascii }
  if (tool === 'legal_moves') return { candidates: r.candidates }
  if (tool === 'search') return { best: r.best, scores: r.scores, pv: r.pv, nodes: r.nodes }
  if (tool === 'forecast') return { events: r.events }
  if (tool === 'eval') return r
  if (tool === 'note') return { text: r.text }
  return r
}

/** 纯本地模式：不经过服务器，直接在内存里跑（测试 / 基准 / 离线回放用） */
export function offlineRun(match, seat, tool, args) {
  return runTool(match, seat, tool, args)
}
