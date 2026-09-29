import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEventStream, forecast, resolveCell, permutationFromStream } from '../src/core/stream.js'
import { moveGrid, applyMove, createGame, DIRS, canMove } from '../src/core/g2048.js'
import { createMatch, snapshot, move, lockState, canSeatMove } from '../src/core/match.js'
import { runTool } from '../src/core/tools.js'
import { evaluate, search } from '../src/core/eval.js'

const B = (rows) => rows.flat()

/** 找一个真能动的方向（开局某些方向是无效的） */
function playDir(m, seat, prefer = ['left', 'down', 'right', 'up']) {
  for (const d of prefer) {
    const before = m.seats[seat].game.moves
    const r = move(m, seat, d)
    if (m.seats[seat].game.moves > before) return r
  }
  return null
}

test('移动与合并规则', () => {
  const g = B([[2, 2, 0, 0], [4, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])
  const r = moveGrid(g, 'left')
  assert.equal(r.moved, true)
  assert.deepEqual(r.grid.slice(0, 4), [4, 0, 0, 0])
  assert.equal(r.gained, 4)
  const same = moveGrid(g, 'up')   // 每列本来就贴顶：不动
  assert.equal(same.moved, false)
  assert.deepEqual(moveGrid(g, 'right').grid.slice(0, 4), [0, 0, 0, 4]) // 同样合并，只是靠右
})

test('同一事件流：两个座位消费同一条事件', () => {
  const s = createEventStream({ seed: 'x' })
  assert.deepEqual(s.events[0], s.events[0])
  assert.deepEqual(forecast(s, 3, 2).map((e) => e.value), [s.events[3].value, s.events[4].value])
})

test('就近落子：意图格被占时落到最近的空格', () => {
  const grid = new Array(16).fill(0)
  grid[0] = 2 // 事件想落在 0
  const cell = resolveCell(grid, { cell: 0, value: 4 }, 1)
  assert.equal(grid[cell], 0)
  assert.notEqual(cell, 0)
})

test('严格同步：同样的走法 → 完全一致的两块棋盘', () => {
  const m = createMatch({ seed: 'sync' })
  for (const d of ['left', 'down', 'right', 'down']) { move(m, 'human', d); move(m, 'agent', d) }
  assert.deepEqual(m.seats.human.game.grid, m.seats.agent.game.grid)
  assert.equal(m.seats.human.game.spawnIndex, m.seats.agent.game.spawnIndex)
  assert.equal(m.divergence.firstLayout, null)
})

test('不同走法 → 记下分岔点，且方块集合仍可比', () => {
  const m = createMatch({ seed: 'fork' })
  move(m, 'human', 'left')
  move(m, 'agent', 'up')   // 故意不同
  assert.notEqual(m.divergence.firstLayout, null)
  const s = snapshot(m)
  assert.ok(s.trace.length >= 2)
  assert.equal(s.seats.human.game.moves, 1)
  assert.equal(s.seats.agent.game.moves, 1)
})

test('工具层：Agent 只能通过工具读和动，且留痕', async () => {
  const m = createMatch({ seed: 'tools', pace: 'free' }) // 本用例测工具层，节奏锁另测
  const b = await runTool(m, 'agent', 'board', {})
  assert.match(b.result.ascii, /\d|\./)
  const before = JSON.stringify(m.seats.agent.game.grid)
  await runTool(m, 'agent', 'note', { text: '先锁右下角' })
  const lm = await runTool(m, 'agent', 'legal_moves', {})
  assert.ok(lm.result.legal.length > 0)
  const sr = await runTool(m, 'agent', 'search', { depth: 2, budget: 3000 })
  assert.ok(['up', 'down', 'left', 'right'].includes(sr.result.best))
  const mv = await runTool(m, 'agent', 'move', { dir: sr.result.best })
  assert.ok(mv.result.moved)
  assert.notEqual(JSON.stringify(m.seats.agent.game.grid), before)
  assert.ok(m.seats.agent.stats.toolCalls >= 4)
  assert.ok(m.seats.agent.game.moves === 1)
  // 座位隔离
  const op = await runTool(m, 'agent', 'opponent', {})
  assert.equal(op.result.on, false)
})

test('搜索是确定性的（同输入同输出，可当 handicap 用）', () => {
  const grid = B([[2, 4, 8, 16], [4, 8, 16, 32], [8, 16, 32, 64], [0, 2, 4, 0]])
  const a = search(grid, { depth: 3, budget: 5000 })
  const b = search(grid, { depth: 3, budget: 5000 })
  assert.equal(a.dir, b.dir)
  assert.equal(a.nodes, b.nodes)
})

test('评估函数：空棋盘分低、蛇形局面分高', () => {
  const empty = new Array(16).fill(0)
  const snake = B([[1024, 512, 256, 128], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])
  assert.ok(evaluate(snake) > evaluate(empty))
})

test('洗牌挑战：两侧得到同一个置换', () => {
  const m = createMatch({ seed: 'ch', challenges: { 2: 'shuffle' } })
  move(m, 'human', 'left'); move(m, 'agent', 'left')
  const p = permutationFromStream(m.stream, 2)
  assert.equal(m.seats.human.game.grid.length, 16)
  move(m, 'human', 'up'); move(m, 'agent', 'up')
  assert.ok(m.events.some((e) => e.type === 'challenge'))
  assert.deepEqual(m.seats.human.game.grid.slice().sort(), m.seats.agent.game.grid.slice().sort())
  assert.equal(p.length, 16)
})

test('对局结束判定', () => {
  const g = createGame({ stream: createEventStream({ seed: 'end' }) })
  g.grid = [2, 4, 2, 4, 4, 2, 4, 2, 8, 8, 8, 8, 0, 0, 0, 0]
  assert.equal(canMove(g.grid), true)
  g.grid = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2]
  assert.equal(canMove(g.grid), false)
})

test('非法移动不消耗事件流', () => {
  const m = createMatch({ seed: 'nomove' })
  const g = m.seats.agent.game
  g.grid = new Array(16).fill(0); g.grid[0] = 2
  const idx = g.spawnIndex
  const r = applyMove(g, 'up', m.stream)
  assert.equal(r.moved, false)
  assert.equal(g.spawnIndex, idx)
  assert.ok(DIRS.length === 4)
})

// ---------------- 节奏锁 ----------------

test('锁步：开局 AI 不能先走', async () => {
  const m = createMatch({ seed: 'lock1' })
  assert.equal(lockState(m).locked, true)
  assert.equal(canSeatMove(m, 'agent'), false)
  const r = await runTool(m, 'agent', 'move', { dir: 'left' })
  assert.equal(r.result.locked, true)
  assert.equal(m.seats.agent.game.moves, 0, 'AI 不该动')
})

test('锁步：被拦不消耗共享事件流，且留痕', async () => {
  const m = createMatch({ seed: 'lock2' })
  const idx = m.seats.agent.game.spawnIndex
  await runTool(m, 'agent', 'move', { dir: 'left' })
  assert.equal(m.seats.agent.game.spawnIndex, idx, '事件流游标不应前进')
  const last = m.trace[m.trace.length - 1]
  assert.equal(last.kind, 'locked')
  assert.equal(last.ok, false)
})

test('锁步：人类一步 → AI 恰好一步 → 再被锁', () => {
  const m = createMatch({ seed: 'lock3' })
  // 人类先走一步
  move(m, 'human', 'left')
  assert.equal(lockState(m).locked, false, '人类走完后应轮到 AI')
  assert.equal(lockState(m).next, 'agent')
  // AI 走一步
  move(m, 'agent', 'up')
  assert.equal(m.seats.agent.game.moves, 1)
  // AI 又被锁上，且不能领先
  assert.equal(lockState(m).locked, true)
  move(m, 'agent', 'down')
  assert.equal(m.seats.agent.game.moves, 1, 'AI 不能领先人类一步')
  assert.equal(m.seats.human.game.moves, 1)
})

test('锁步：思考类工具不受锁', async () => {
  const m = createMatch({ seed: 'lock4' })
  assert.equal(canSeatMove(m, 'agent'), false)
  assert.ok((await runTool(m, 'agent', 'board', {})).ok)
  assert.ok((await runTool(m, 'agent', 'forecast', { n: 2 })).ok)
  assert.ok((await runTool(m, 'agent', 'search', { depth: 2, budget: 2000 })).ok)
  assert.ok((await runTool(m, 'agent', 'note', { text: '等人类走的时候我在算' })).result.ok)
  assert.equal(m.seats.agent.game.moves, 0)
  assert.equal(lockState(m).locked, true)
})

test('锁步：turn 工具告诉 Agent 能不能走', async () => {
  const m = createMatch({ seed: 'lock5' })
  const t0 = (await runTool(m, 'agent', 'turn', {})).result
  assert.equal(t0.locked, true)
  assert.equal(t0.youCanMove, false)
  assert.equal(t0.next, 'human')
  playDir(m, 'human')
  const t1 = (await runTool(m, 'agent', 'turn', {})).result
  assert.equal(t1.youCanMove, true)
  assert.equal(t1.next, 'agent')
})

test('锁步：人类输掉后解锁，AI 自由跑完', () => {
  const m = createMatch({ seed: 'lock6' })
  // 把人类棋盘做成死局
  m.seats.human.game.grid = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2]
  m.seats.human.game.status = 'lost'
  const L = lockState(m)
  assert.equal(L.locked, false)
  assert.equal(canSeatMove(m, 'agent'), true)
  const r = move(m, 'agent', 'left')
  assert.equal(r.locked, undefined)
  assert.equal(m.seats.agent.game.moves, 1)
})

test('自由模式：AI 可以自己往前跑（旧行为）', () => {
  const m = createMatch({ seed: 'free1', pace: 'free' })
  assert.equal(lockState(m).locked, false)
  for (let i = 0; i < 4; i++) move(m, 'agent', 'left')
  assert.equal(m.seats.agent.game.moves, 4, '自由模式下 AI 步数可以远超人类')
  assert.equal(m.seats.human.game.moves, 0)
})

test('锁步：全程 AI 步数永远不超过人类', () => {
  const m = createMatch({ seed: 'lock7' })
  for (let i = 0; i < 12; i++) {
    move(m, 'human', ['left', 'down', 'right', 'down'][i % 4])
    move(m, 'agent', ['up', 'left', 'down', 'right'][i % 4])
    assert.ok(m.seats.agent.game.moves <= m.seats.human.game.moves, `第 ${i} 轮 AI 领先了`)
    assert.ok(m.seats.agent.game.moves >= m.seats.human.game.moves - 1)
  }
})
