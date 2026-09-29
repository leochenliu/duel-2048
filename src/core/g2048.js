// 2048 规则内核：纯函数 + 显式状态，无副作用，方便回放与差分测试
import { resolveCell } from './stream.js'

export const CELLS = 16
export const SIZE = 4
export const DIRS = ['up', 'down', 'left', 'right']
export const DIR_KEYS = { up: 'up', w: 'up', arrowup: 'up', down: 'down', s: 'down', arrowdown: 'down', left: 'left', a: 'left', arrowleft: 'left', right: 'right', d: 'right', arrowright: 'right' }

// 每条线都按"合并方向"排列：left=行左→右, right=行右→左, up=列上→下, down=列下→上
const LINES = {
  left: [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]],
  right: [[3, 2, 1, 0], [7, 6, 5, 4], [11, 10, 9, 8], [15, 14, 13, 12]],
  up: [[0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15]],
  down: [[12, 8, 4, 0], [13, 9, 5, 1], [14, 10, 6, 2], [15, 11, 7, 3]],
}

function processLine(line) {
  const vals = []
  for (const v of line) if (v !== 0) vals.push(v)
  const out = []
  let gained = 0
  for (let i = 0; i < vals.length; i++) {
    if (i + 1 < vals.length && vals[i] === vals[i + 1]) {
      out.push(vals[i] * 2)
      gained += vals[i] * 2
      i++
    } else out.push(vals[i])
  }
  while (out.length < 4) out.push(0)
  return { out, gained }
}

/** 在棋盘上模拟一次移动（不落子）。纯函数。 */
export function moveGrid(grid, dir) {
  const next = grid.slice()
  let gained = 0
  for (const line of LINES[dir]) {
    const { out, gained: g } = processLine(line.map((c) => grid[c]))
    gained += g
    line.forEach((c, k) => { next[c] = out[k] })
  }
  const moved = gained > 0 || next.some((v, i) => v !== grid[i])
  return { grid: next, gained, moved }
}

export function canMove(grid) {
  return DIRS.some((d) => moveGrid(grid, d).moved)
}

export function maxTile(grid) {
  return grid.reduce((a, b) => (b > a ? b : a), 0)
}

/** 创建一局；两个座位共享同一个 stream，但各自有独立的消费游标 */
export function createGame({ stream, target = 2048, spawnIndex = 0 } = {}) {
  const state = {
    grid: new Array(CELLS).fill(0),
    score: 0,
    moves: 0,
    maxTile: 0,
    target,
    status: 'playing', // playing | won | lost
    spawnIndex,
    lastMove: null,
    lastSpawn: null,
    lastGain: 0,
    spawned: [],
    history: [], // 每步快照：用于精确计算"分岔点"（两侧可异步行动）
  }
  return state
}

/** 消费共享事件流的下一条事件并落子 */
export function spawn(state, stream) {
  const ev = stream.events[state.spawnIndex]
  if (!ev) return null
  state.spawnIndex += 1
  const cell = resolveCell(state.grid, ev, state.spawnIndex)
  if (cell === null) return null
  state.grid[cell] = ev.value
  const rec = { ticket: state.spawnIndex, value: ev.value, want: ev.cell, landed: cell }
  state.lastSpawn = rec
  state.spawned.push(rec)
  return rec
}

/** 走一步。返回 {moved, gained, spawn, won, lost} */
export function applyMove(state, dir, stream) {
  if (state.status !== 'playing') return { moved: false, reason: state.status }
  const { grid, gained, moved } = moveGrid(state.grid, dir)
  if (!moved) return { moved: false, gained: 0, spawn: null }
  state.grid = grid
  state.score += gained
  state.moves += 1
  state.lastMove = dir
  state.lastGain = gained
  const sp = spawn(state, stream)
  state.maxTile = maxTile(state.grid)
  state.history.push(state.grid.slice())
  if (state.history.length > 4000) state.history.shift()
  if (state.maxTile >= state.target) state.status = 'won'
  else if (!canMove(state.grid)) state.status = 'lost'
  return { moved: true, gained, spawn: sp, won: state.status === 'won', lost: state.status === 'lost' }
}

/** 对外视图（给左栏渲染） */
export function view(state) {
  return {
    rows: [0, 1, 2, 3].map((r) => state.grid.slice(r * 4, r * 4 + 4)),
    grid: state.grid.slice(),
    score: state.score,
    moves: state.moves,
    maxTile: state.maxTile,
    target: state.target,
    status: state.status,
    lastMove: state.lastMove,
    lastSpawn: state.lastSpawn,
    lastGain: state.lastGain,
    spawnIndex: state.spawnIndex,
    spawned: state.spawned.slice(-16),
  }
}
