// 共享事件流（Shared Event Stream）
// ---------------------------------------------------------------
// 这是"同样的上下文"的技术保证：全局只生成一条随机事件流，
// 两个座位（人类 / Agent）各自按自己的第 k 次落子消费同一条事件。
// 于是两边拿到的数值分布、难度、运气完全一致，
// 差异 100% 来自决策 —— 这就是"同题异解"。
import { mulberry32, hashSeed, hash2 } from './rng.js'

export const DEFAULT_EVENTS = 20000

/**
 * 预生成事件流。事件与"生成时刻"无关，只与"消费序号"有关，
 * 因此任何一方的第 k 次落子，拿到的都是流里第 k 条事件。
 * @param {object} o
 * @param {string|number} o.seed
 * @param {number} [o.count]
 * @param {number} [o.cells]
 */
export function createEventStream({ seed = 'duel', count = DEFAULT_EVENTS, cells = 16 } = {}) {
  const rand = mulberry32(hashSeed(`stream:${seed}`))
  const events = new Array(count)
  for (let i = 0; i < count; i++) {
    events[i] = {
      i,
      value: rand() < 0.9 ? 2 : 4,
      cell: Math.floor(rand() * cells),
    }
  }
  return { seed, cells, events, count }
}

const manhattan = (a, b) => {
  const ar = (a / 4) | 0, ac = a % 4
  const br = (b / 4) | 0, bc = b % 4
  return Math.abs(ar - br) + Math.abs(ac - bc)
}

/**
 * 就近落子（Same Event, Locally Resolved）
 * 事件里的 cell 是"意图位置"。如果这一格已被占用（因为两边走的路不同），
 * 就按 (曼哈顿距离, 稳定散列) 的确定性顺序找最近的空格。
 * —— 保证两边面对的是同一个事件，且落点尽量同区域，噪音可控。
 * @param {number[]} grid 16 格棋盘
 * @param {{cell:number,value:number}} event
 * @param {number} ticket 消费序号，用于稳定打散
 */
export function resolveCell(grid, event, ticket) {
  if (grid[event.cell] === 0) return event.cell
  const order = []
  for (let c = 0; c < grid.length; c++) {
    if (grid[c] !== 0) continue
    order.push([manhattan(c, event.cell), hash2(ticket, c), c])
  }
  if (!order.length) return null
  order.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  return order[0][2]
}

/** 预告：某座位接下来会面对的 n 条事件（两侧完全相同） */
export function forecast(stream, fromIndex, n = 3) {
  const out = []
  for (let k = fromIndex; k < Math.min(stream.count, fromIndex + n); k++) {
    const e = stream.events[k]
    out.push({ i: e.i, value: e.value, cell: e.cell })
  }
  return out
}

/** 由事件流派生一个确定性置换（用于"同一次洗牌"挑战） */
export function permutationFromStream(stream, ticket, cells = 16) {
  const rand = mulberry32(hashSeed(`perm:${stream.seed}:${ticket}`))
  const idx = Array.from({ length: cells }, (_, i) => i)
  for (let i = cells - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]]
  }
  return idx
}
