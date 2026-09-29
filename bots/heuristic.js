#!/usr/bin/env node
// 内置对手：一个"只会用工具"的 AI。
// 它不碰内部状态，只按 skill 的节奏 board → search → note → move。
import { createMatch, snapshot } from '../src/core/match.js'
import { runTool } from '../src/core/tools.js'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); if (i < 0) return d; const v = argv[i + 1]; return !v || v.startsWith('--') ? true : v }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const DEPTH = Number(flag('depth', 3))
const BUDGET = Number(flag('budget', 20000))
const PACE = Number(flag('pace', 900))       // 自由模式下的每步停顿（ms）
const POLL = Number(flag('poll', 220))       // 锁步模式下轮询自己回合的间隔
const MAXMOVES = Number(flag('max-moves', 4000))
const THINK_EARLY = flag('think-early', false) === true || flag('think-early') === 'true'
const BOTH = flag('both', false) === true || flag('both') === 'true'
const URL_BASE = process.env.G2048_URL || 'http://localhost:5173'
const ID = flag('id', process.env.G2048_ID)


async function remote(seat, tool, args) {
  const r = await fetch(`${URL_BASE}/api/match/${ID}/tool/${seat}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, args }),
  })
  return r.json()
}

/** 说人话：把搜索结果翻译成一句可读的策略说明，写进右栏 */
function explain(board, result, forecast, seat = 'agent') {
  const empties = board.grid.filter((v) => !v).length
  const maxIdx = board.grid.indexOf(board.maxTile)
  const corner = maxIdx === 0 || maxIdx === 3 || maxIdx === 12 || maxIdx === 15
  const bits = []
  if (seat === 'human') bits.push('【内置 AI 代打人类席】')
  bits.push(`空格${empties}`)
  bits.push(corner ? '最大值在角落·蛇形成立' : '最大值离角落偏远')
  bits.push(`首选${result.best}(depth${result.depth}/${result.nodes}节点)`)
  if (result.scores.length) {
    const worst = result.scores[result.scores.length - 1]
    bits.push(`避开${worst.dir}`)
  }
  if (forecast?.on && forecast.events?.length) bits.push(`已预报下块${forecast.events[0].value}@${forecast.events[0].cell}`)
  return bits.join('；')
}

async function playOnce(call, seat = 'agent') {
  for (let i = 0; i < MAXMOVES; i++) {
    // 阶段 1：等自己的回合（锁步模式的核心 —— 绝不领先人类一步）
    let waited = 0
    for (;;) {
      const t = await call(seat, 'turn', {})
      if (!t.ok) throw new Error(t.error)
      const L = t.result
      if (L[seat + 'Status'] !== 'playing') return { status: L[seat + 'Status'], maxTile: 0, moves: L[seat + 'Moves'] }
      if (L.youCanMove) break
      if (++waited > 200000) return { status: 'gave-up-waiting' }
      // --think-early：人类还在想的时候，我先把候选算好（思考不受锁）
      if (THINK_EARLY && waited % 20 === 0) {
        const bd = await call(seat, 'board', {})
        const sr = await call(seat, 'search', { depth: DEPTH, budget: BUDGET })
        if (sr.ok && sr.result.best) {
          await call(seat, 'note', { text: `【预演】还没轮到我，但我先算好了：目前倾向 ${sr.result.best}（人类步数 ${L.humanMoves}）` })
        }
      }
      await sleep(POLL)
    }
    // 阶段 2：一个回合 = 一次完整思考 + 恰好一步
    const st = await call(seat, 'status', {})
    if (!st.ok) throw new Error(st.error)
    const me = st.result.seats[seat]
    if (me.status !== 'playing') return me
    const bd = await call(seat, 'board', {})
    if (!bd.ok) throw new Error(bd.error)
    const fc = await call(seat, 'forecast', { n: 2 })
    const sr = await call(seat, 'search', { depth: DEPTH, budget: BUDGET })
    if (!sr.ok) throw new Error(sr.error)
    const r = sr.result
    if (!r.best) return me
    await call(seat, 'note', { text: explain(bd.result.view, r, fc.ok ? fc.result : null, seat) })
    const mv = await call(seat, 'move', { dir: r.best })
    if (!mv.ok) return me
    if (mv.result.locked) { await sleep(POLL); continue }
    if (!mv.result.moved) return me
    if (PACE) await sleep(PACE)
  }
  const st = await call(seat, 'status', {})
  return st.ok ? st.result.seats[seat] : { status: 'timeout' }
}

/** 演示模式：两个座位都由内置 AI 驱动，轮流走，用来验证锁步节奏 */
async function playBoth(call) {
  let i = 0
  for (; i < MAXMOVES * 2; i++) {
    const st = await call('human', 'status', {})
    if (!st.ok) break
    const { human, agent } = st.result.seats
    if (human.status !== 'playing' && agent.status !== 'playing') break
    for (const seat of ['human', 'agent']) {
      const s = seat === 'human' ? human : agent
      if (s.status !== 'playing') continue
      const bd = await call(seat, 'board', {})
      const sr = await call(seat, 'search', { depth: DEPTH, budget: BUDGET })
      if (!sr.ok || !sr.result.best) continue
      const mv = await call(seat, 'move', { dir: sr.result.best })
      if (!mv.ok) { console.log(`  [${seat}] 被拦/失败：`, mv.result?.reason || mv.error); break }
      console.log(`  [${seat}] ${mv.result.moved ? mv.result.gained : 0} 分 → 最高 ${mv.result.maxTile}｜空格 ${bd.result.view.grid.filter((v) => !v).length}`)
      await sleep(PACE)
    }
  }
  const st = await call('human', 'status', {})
  const s = st.result.seats
  console.log(`\n结束：人类 最高 ${s.human.maxTile} / 分数 ${s.human.score} / ${s.human.moves} 步`)
  console.log(`      Agent 最高 ${s.agent.maxTile} / 分数 ${s.agent.score} / ${s.agent.moves} 步`)
}

// ---- 离线基准：不连服务器，直接在内存里打完一局，标定 handicap 档位 ----
async function bench() {
  const seeds = argv.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a))
  const list = seeds.length ? seeds : ['bench-1', 'bench-2', 'bench-3']
  console.log(`离线基准  depth=${DEPTH} budget=${BUDGET}  事件流=严格同步\n`)
  let tot = 0
  for (const seed of list) {
    const m = createMatch({ seed, sync: 'strict', pace: 'free' })
    const call = (seat, tool, args) => runTool(m, seat, tool, args, { log: false })
    const r = await playOnce(call, 'agent')
    tot += r.maxTile || 0
    console.log(`  seed=${seed.padEnd(10)} 最高方块=${String(r.maxTile).padStart(5)}  步数=${String(r.moves).padStart(5)}  分数=${r.score}`)
  }
  console.log(`\n  平均最高方块 = ${(tot / list.length).toFixed(0)}`)
  console.log('  人类要赢，得在这条共享事件流上做得更好 —— 提示：善用 forecast 提前腾出预报格。\n')
}

if (flag('bench', false) === true || flag('bench') === 'true') await bench()
else {
  if (!ID || ID === true) { console.error('需要 --id <matchId>（或先在网页上开一局）'); process.exit(2) }
  const call = (seat, tool, args) => remote(seat, tool, args)
  if (BOTH) await playBoth(call)
  else {
    const r = await playOnce(call, 'agent')
    console.log(`\nAgent 席结束：最高方块 ${r.maxTile}，步数 ${r.moves}，分数 ${r.score}\n`)
  }
}
