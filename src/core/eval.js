// 评估函数 + 期望极大搜索（可预算、可复现）
// 这是"右栏 Agent 看得见但人类看不见的层"：过程差异的算力来源。
import { DIRS, moveGrid } from './g2048.js'

const W_EMPTY = 270
const W_MERGE = 120
const W_MONO = 90
const W_SMOOTH = 60
const W_CORNER = 900
const W_SNAKE = 60

// 蛇形权重：把大方块往角落推
const SNAKE = [
  [0, 1, 2, 3],
  [7, 6, 5, 4],
  [8, 9, 10, 11],
  [15, 14, 13, 12],
]
const LOG2 = new Map()
const log2 = (v) => {
  if (!LOG2.has(v)) LOG2.set(v, Math.log2(v))
  return LOG2.get(v)
}

export function evaluate(grid) {
  let s = 0
  let empty = 0
  let max = 0
  let maxIdx = -1
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i]
    if (v === 0) { empty++; continue }
    if (v > max) { max = v; maxIdx = i }
  }
  s += empty * W_EMPTY

  const r = (i) => (i / 4) | 0
  const c = (i) => i % 4

  // 合并潜力：相邻等值
  for (let i = 0; i < 16; i++) {
    const v = grid[i]
    if (!v) continue
    if (c(i) < 3 && grid[i + 1] === v) s += v * W_MERGE
    if (r(i) < 3 && grid[i + 4] === v) s += v * W_MERGE
    // 平滑度
    if (c(i) < 3 && grid[i + 1]) s -= Math.abs(log2(v) - log2(grid[i + 1])) * W_SMOOTH
    if (r(i) < 3 && grid[i + 4]) s -= Math.abs(log2(v) - log2(grid[i + 4])) * W_SMOOTH
  }
  let snake = 0
  for (let i = 0; i < 16; i++) {
    if (!grid[i]) continue
    snake += log2(grid[i]) * (1 << SNAKE[r(i)][c(i)])
  }
  s += snake * W_SNAKE

  // 单调性：行/列，递增与递减各算一次
  for (let i = 0; i < 4; i++) {
    let up = 0, down = 0
    for (let k = 0; k < 3; k++) {
      const a = grid[i * 4 + k], b = grid[i * 4 + k + 1]
      if (a && b) { up += log2(b) - log2(a); down += log2(a) - log2(b) }
    }
    s += (up > 0 ? up : down) * W_MONO
    let l = 0, rr = 0
    for (let k = 0; k < 3; k++) {
      const a = grid[k * 4 + i], b = grid[(k + 1) * 4 + i]
      if (a && b) { l += log2(b) - log2(a); rr += log2(a) - log2(b) }
    }
    s += (l > 0 ? l : rr) * W_MONO
  }

  if (maxIdx >= 0 && (maxIdx === 0 || maxIdx === 3 || maxIdx === 12 || maxIdx === 15)) {
    s += Math.sqrt(max) * W_CORNER
  }
  return s
}

/** 对每个合法方向打分（process 面板要展示的"候选"） */
export function scoreMoves(grid) {
  return DIRS.map((dir) => {
    const { grid: g, moved } = moveGrid(grid, dir)
    return { dir, moved, score: moved ? evaluate(g) : -Infinity, child: g }
  }).sort((a, b) => b.score - a.score)
}

class Budget {
  constructor(n) { this.left = n; this.used = 0 }
  tick() { this.used++; this.left -= 1; return this.left > 0 }
}

function chanceNode(grid, depth, budget) {
  const empties = []
  for (let i = 0; i < grid.length; i++) if (!grid[i]) empties.push(i)
  if (!empties.length) return evaluate(grid)
  let total = 0
  let n = 0
  for (const cell of empties) {
    for (const [value, p] of [[2, 0.9], [4, 0.1]]) {
      if (budget.tick()) {
        const g = grid.slice()
        g[cell] = value
        total += p * expectimax(g, depth - 1, budget)
        n += 1
      }
    }
  }
  return n ? total / empties.length : evaluate(grid) // 空格均匀分布下的期望值
}

function expectimax(grid, depth, budget) {
  if (depth <= 0) return evaluate(grid)
  let best = -Infinity
  const moves = []
  for (const dir of DIRS) {
    const { grid: g, moved } = moveGrid(grid, dir)
    if (moved) moves.push({ dir, g })
  }
  if (!moves.length) return evaluate(grid)
  moves.sort((a, b) => evaluate(b.g) - evaluate(a.g)) // 走法排序：预算有限时先搜好棋
  for (const m of moves) {
    if (!budget.tick()) break
    best = Math.max(best, chanceNode(m.g, depth - 1, budget))
  }
  return best === -Infinity ? evaluate(grid) : best
}

/**
 * 期望极大搜索，纯函数、可复现（只有节点预算，没有时间截断）
 * @returns {{dir:string, score:number, nodes:number, pv:string[], scores:Array}}
 */
export function search(grid, { depth = 3, budget = 20000 } = {}) {
  const b = new Budget(budget)
  const cands = scoreMoves(grid)
  const legal = cands.filter((c) => c.moved)
  if (!legal.length) return { dir: null, score: -Infinity, nodes: 0, pv: [], scores: [] }
  let best = legal[0]
  const scores = []
  const firstLevel = []
  for (const cand of legal) {
    if (b.tick()) {
      const sc = depth <= 1 ? evaluate(cand.child) : chanceNode(cand.child, depth - 1, b)
      firstLevel.push({ dir: cand.dir, score: sc, child: cand.child })
    } else {
      firstLevel.push({ dir: cand.dir, score: evaluate(cand.child), child: cand.child })
    }
  }
  firstLevel.sort((a, b2) => b2.score - a.score)
  for (const f of firstLevel) if (f.score > best.score) best = { dir: f.dir, score: f.score }
  for (const f of firstLevel) scores.push({ dir: f.dir, score: Math.round(f.score) })
  // 极小的 principal variation：最深的一层选择
  const pv = [best.dir]
  if (depth >= 2 && firstLevel.length) {
    const top = firstLevel[0]
    const second = scoreMoves(top.child).filter((m) => m.moved)[0]
    if (second) pv.push(second.dir)
  }
  return { dir: best.dir, score: best.score, nodes: b.used, pv, scores, depth }
}
