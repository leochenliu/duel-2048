// 对局（Match）：一个权威世界，两个座位，一条共享事件流
// ---------------------------------------------------------------
// 保证「同样的上下文」：
//   1. 同一 seed  → 同一事件流（数值/位置序列）
//   2. 各自的第 k 次落子消费同一条事件 k
//   3. 挑战事件（洗牌/定点投放）对两边施加同一变换
// 保证「过程不同」：
//   每一步的决策、耗时、工具调用、思考记录全部独立留痕，永不合流。
import { createEventStream, forecast, permutationFromStream, resolveCell } from './stream.js'
import { createGame, applyMove, view, canMove, DIRS } from './g2048.js'

export const SEATS = ['human', 'agent']

export function createMatch({
  seed = String(Date.now()),
  target = 2048,
  sync = 'strict',      // strict | value | none
  forecastOn = true,    // 是否允许预告共享事件流
  crossSeat = false,    // 是否允许 Agent 读人类棋盘（作弊开关）
  pace = 'lock',        // lock = AI 跟在人类后面逐步走 | free = AI 自由发展
  challenges = {},      // { 10: 'shuffle', 20: 'bonus' }
} = {}) {
  const stream = createEventStream({ seed })
  const match = {
    id: 'm' + Math.random().toString(36).slice(2, 9),
    seed, target, sync, forecastOn, crossSeat, pace,
    stream,
    challenges,
    createdAt: Date.now(),
    step: 0,
    seats: {},
    trace: [],
    events: [],
    divergence: { firstLayout: null, firstValue: null, layoutSame: true, valueSame: true },
    over: false,
    winner: null,
  }
  for (const seat of SEATS) {
    const game = createGame({ stream, target })
    match.seats[seat] = {
      seat,
      game,
      stats: { moves: 0, toolCalls: 0, readMs: 0, thinkMs: 0, notes: 0, polls: 0, waitMs: 0, lastThinkAt: null },
      pendingReasoning: [],
    }
  }
  // 初始两块：两个座位消费同一条流的前两条事件
  for (const seat of SEATS) {
    const g = match.seats[seat].game
    spawnInit(g, stream)
  }
  compare(match)
  pushEvent(match, 'match.created', { seed, target, sync, forecastOn })
  return match
}

function spawnInit(game, stream) {
  // 用与 spawn 相同的路径，保证开局也共享事件
  for (let k = 0; k < 2; k++) {
    const ev = stream.events[game.spawnIndex]
    if (!ev) return
    game.spawnIndex += 1
    const cell = resolveCell(game.grid, ev, game.spawnIndex)
    if (cell === null) return
    game.grid[cell] = ev.value
    game.spawned.push({ ticket: game.spawnIndex, value: ev.value, want: ev.cell, landed: cell })
  }
}

/**
 * 节奏锁（Pace Lock）
 * ---------------------------------------------------------------
 * lock 模式：AI 不能领先人类。每当人类走完一步，才给 AI 解锁一步。
 *   locked = 人类还在玩 且 AI 的步数 >= 人类的步数
 * 关键：锁的只是「落子」，不锁「思考」——
 * board / forecast / search / note 随时可用，所以右栏的过程流照样能填满。
 * 人类分出胜负后解锁，让 AI 自己跑完（方便看它的终局成绩）。
 */
export function lockState(match) {
  const h = match.seats.human.game
  const a = match.seats.agent.game
  const base = { mode: match.pace, humanMoves: h.moves, agentMoves: a.moves, humanStatus: h.status, agentStatus: a.status }
  if (match.pace === 'free') {
    return { ...base, locked: false, next: 'any', reason: '自由模式：AI 按自己的节奏走' }
  }
  if (h.status !== 'playing') {
    return { ...base, locked: false, next: 'agent', reason: '人类已结束，AI 自由收尾' }
  }
  if (a.moves < h.moves) {
    return { ...base, locked: false, next: 'agent', reason: 'AI 的回合' }
  }
  return { ...base, locked: true, next: 'human', reason: '锁步中：等人类先走，AI 只能跟在后面' }
}

export function canSeatMove(match, seat) {
  if (seat === 'human') return match.seats.human.game.status === 'playing'
  return !lockState(match).locked
}

export function seatView(match, seat) {
  const s = match.seats[seat]
  return {
    seat,
    game: view(s.game),
    stats: s.stats,
    open: match.seats[seat].game.status === 'playing',
  }
}

export function snapshot(match) {
  return {
    id: match.id,
    seed: match.seed,
    target: match.target,
    sync: match.sync,
    pace: match.pace,
    forecastOn: match.forecastOn,
    crossSeat: match.crossSeat,
    step: match.step,
    over: match.over,
    winner: match.winner,
    challenges: match.challenges,
    divergence: match.divergence,
    lock: lockState(match),
    seats: Object.fromEntries(SEATS.map((s) => [s, seatView(match, s)])),
    forecast: match.forecastOn ? forecast(match.stream, match.seats.human.game.spawnIndex, 3) : null,
    trace: match.trace.slice(-120),
    log: match.events.slice(-40),
  }
}

/** 一致性比较：用两边各自的步快照逐帧比对，所以异步对局也能给出精确分岔点 */
function compare(match) {
  const h = match.seats.human.game
  const a = match.seats.agent.game
  const n = Math.min(h.history.length, a.history.length)
  match.divergence.commonSteps = n
  match.divergence.lead = h.moves - a.moves
  const hist = (g) => {
    const m = new Map()
    for (const v of g) if (v) m.set(v, (m.get(v) || 0) + 1)
    return [...m.entries()].sort().map(([v, c]) => `${v}x${c}`).join(' ')
  }
  for (let k = 0; k < n; k++) {
    const step = k + 1
    if (h.history[k].join(',') !== a.history[k].join(',') && match.divergence.firstLayout === null) {
      match.divergence.firstLayout = { step, at: Date.now() }
      match.divergence.layoutSame = false
      pushEvent(match, 'divergence.layout', { step })
    }
    if (hist(h.history[k]) !== hist(a.history[k]) && match.divergence.firstValue === null) {
      match.divergence.firstValue = { step }
      match.divergence.valueSame = false
      pushEvent(match, 'divergence.value', { step })
    }
  }
}

export function pushEvent(match, type, data) {
  match.events.push({ seq: match.events.length, t: Date.now(), type, data })
  if (match.events.length > 2000) match.events.shift()
}

/** 某座位走一步 */
export function move(match, seat, dir) {
  const s = match.seats[seat]

  // —— 节奏锁：被锁时拒绝落子，但不报错、不消耗事件流，只留下一条可见的记录 ——
  if (!canSeatMove(match, seat)) {
    const l = lockState(match)
    const rec = {
      n: match.trace.length + 1,
      seat, kind: 'locked', tool: 'move', args: { dir },
      ok: false, ms: 0,
      summary: `⛓ 被节奏锁拦住：${l.reason}`,
      step: s.game.moves,
      data: { locked: true, reason: l.reason, next: l.next, humanMoves: l.humanMoves, agentMoves: l.agentMoves },
    }
    match.trace.push(rec)
    s.pendingReasoning.push({ tool: 'move(被拦)', args: { dir }, ms: 0, summary: rec.summary, ok: false })
    pushEvent(match, 'pace.locked', { seat, dir, next: l.next })
    return { moved: false, locked: true, reason: l.reason, next: l.next }
  }

  const before = s.game.moves
  const res = applyMove(s.game, dir, match.stream)
  const rec = {
    n: match.trace.length + 1,
    seat, kind: 'move', tool: 'move', args: { dir },
    ok: res.moved,
    ms: 0,
    summary: res.moved ? `${dir} +${res.gained} → ${s.game.maxTile}` : `非法：${dir} 无变化`,
    step: before + 1,
    data: {
      moved: res.moved, gained: res.gained, spawn: res.spawn,
      maxTile: s.game.maxTile, score: s.game.score,
      reasoning: s.pendingReasoning.splice(0), // 该步之前的过程快照
    },
  }
  match.trace.push(rec)
  s.stats.moves += 1
  s.stats.lastThinkAt = Date.now()
  match.step += 1

  // 挑战事件：两边在同一"步数"上受到同一变换
  const ch = match.challenges[before + 1]
  if (res.moved && ch) applyChallenge(match, ch, seat, before + 1)

  if (s.game.status !== 'playing') {
    pushEvent(match, `seat.${seat}.${s.game.status}`, { maxTile: s.game.maxTile, score: s.game.score })
    finishCheck(match)
  }
  compare(match)
  return { ...rec.data, before }
}

function applyChallenge(match, kind, seat, step) {
  const g = match.seats[seat].game
  if (kind === 'shuffle') {
    // 同一个置换，两边同步洗牌：拿到完全相同的"题面变化"
    const p = permutationFromStream(match.stream, step)
    const next = new Array(16)
    p.forEach((from, to) => { next[to] = g.grid[from] })
    g.grid = next
    pushEvent(match, 'challenge', { kind, step, seat, perm: p })
  } else if (kind === 'bonus') {
    const ev = match.stream.events[(match.seats.human.game.spawnIndex + 7) % match.stream.count]
    const cell = g.grid[ev.cell] === 0 ? ev.cell : g.grid.findIndex((v) => v === 0)
    if (cell >= 0) g.grid[cell] = ev.value
    pushEvent(match, 'challenge', { kind, step, seat, cell })
  }
}

function finishCheck(match) {
  const h = match.seats.human.game
  const a = match.seats.agent.game
  if (h.status !== 'playing' && a.status !== 'playing' && !match.over) {
    match.over = true
    const rank = (g) => (g.status === 'won' ? 2 : 0) + g.maxTile / 100000 + g.score / 1000000
    match.winner = rank(h) === rank(a) ? 'draw' : rank(h) > rank(a) ? 'human' : 'agent'
    pushEvent(match, 'match.over', { winner: match.winner, human: h.maxTile, agent: a.maxTile })
  }
}

/** 记录一次工具调用（Agent 过程留痕的核心） */
export function trace(match, seat, { tool, args = {}, ok = true, ms = 0, summary = '', data = {}, kind = 'tool' }) {
  const s = match.seats[seat]
  const rec = { n: match.trace.length + 1, seat, kind, tool, args, ok, ms, summary, step: s.game.moves, data }
  match.trace.push(rec)
  s.stats.toolCalls += 1
  s.stats.readMs += ms
  s.pendingReasoning.push({ tool, args, ms, summary, ok })
  if (s.pendingReasoning.length > 24) s.pendingReasoning.shift()
  return rec
}

export { forecast, DIRS, canMove }
