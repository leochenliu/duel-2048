#!/usr/bin/env node
// g2048 —— Agent 席的工具 CLI
// 任何 agent harness（pi / claude code / 自己的 loop）都能通过它"看"和"动"。
import { runTool } from '../src/core/tools.js'
import { createMatch, snapshot, SEATS } from '../src/core/match.js'

const argv = process.argv.slice(2)
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name)
  if (i < 0) return def
  const v = argv[i + 1]
  return !v || v.startsWith('--') ? true : v
}
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1].length > 2))
const URL_BASE = process.env.G2048_URL || flag('url', 'http://localhost:5173')
const ID = process.env.G2048_ID || flag('id')
const SEAT = process.env.G2048_SEAT || flag('seat', 'agent')

const USAGE = `
g2048 —— 同题异解 2048 · Agent 席工具

  g2048 new [--seed s] [--target 2048] [--sync strict|value|none] [--forecast-on] [--cross-seat]
            [--challenge 12=shuffle]         新建一局，打印 matchId
  g2048 join [--id M] [--seat agent]        绑定到已有对局（也可直接用已有 id）
  g2048 help                               列出全部工具（等价于工具 help）
  g2048 board                              看自己的棋盘
  g2048 legal-moves                        四个方向的合法性 + 一步启发式分
  g2048 eval                               局面分
  g2048 search [--depth 3] [--budget 20000]
  g2048 forecast [--n 3]                   预告共享事件流
  g2048 turn                              当前节奏锁：{locked, next, youCanMove}
  g2048 opponent                           读对手棋盘（需 crossSeat）
  g2048 note "把 128 锁在右下角"             写一条过程记录，显示在右栏
  g2048 move <up|down|left|right|w|a|s|d>  走一步
  g2048 status                             对局状态 + 分岔点
  g2048 watch                              NDJSON 事件流（跟随式 agent 用）
  g2048 state                              完整快照

环境变量：G2048_URL  G2048_ID  G2048_SEAT
`.trim()

function needId() {
  if (!ID || ID === true) {
    console.error('缺少 --id（先 g2048 new，或 g2048 join --id <matchId>）')
    process.exit(2)
  }
  return String(ID)
}

async function call(tool, args = {}) {
  const res = await fetch(`${URL_BASE}/api/match/${needId()}/tool/${SEAT}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  })
  const out = await res.json()
  if (!res.ok) { console.error(JSON.stringify(out)); process.exit(1) }
  if (out.ok === false) { console.error('✗', out.error || JSON.stringify(out.result)); process.exit(1) }
  return out
}

function out(x) { console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2)) }

const cmd = pos[0]

if (cmd === 'new') {
  const body = {
    seed: flag('seed', String(Date.now())),
    target: Number(flag('target', 2048)),
    sync: String(flag('sync', 'strict')),
    pace: String(flag('pace', 'lock')),
    forecastOn: flag('forecast-on', null) === null ? true : flag('forecast-on') !== 'false',
    crossSeat: flag('cross-seat', false) === true || flag('cross-seat') === 'true',
  }
  const ch = flag('challenge')
  if (ch && ch !== true) {
    body.challenges = {}
    for (const pair of String(ch).split(',')) { const [k, v] = pair.split('='); if (k && v) body.challenges[Number(k)] = v }
  }
  const r = await fetch(`${URL_BASE}/api/match`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json()
  console.log(j.id)
  console.error(`\n下一步： g2048 board --id ${j.id} --seat agent`)
  process.exit(0)
}

if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') { console.log(USAGE); process.exit(0) }

// 纯本地模式：完全离线，不需要服务器（测试 / 基准 / 快速试玩）
if (flag('local', false) === true || flag('local') === 'true') {
  const m = createMatch({ seed: flag('seed', 'local'), target: Number(flag('target', 2048)) })
  for (const c of pos.slice(1)) {
    const [t, ...rest] = c.split(':')
    const args = {}
    if (t === 'move') args.dir = rest[0]
    if (t === 'note') args.text = rest.join(':')
    if (t === 'search') { args.depth = Number(rest[0] || 3); args.budget = Number(rest[1] || 20000) }
    const r = await runTool(m, SEAT, t.replace(/-/g, '_'), args)
    out(r.ok === false ? r : r.result)
  }
  process.exit(0)
}

switch (cmd) {
  case 'join': {
    const r = await fetch(`${URL_BASE}/api/match/${needId()}`)
    if (!r.ok) { console.error('对局不存在，请先 g2048 new'); process.exit(1) }
    out(`已加入对局 ${ID}，座位 ${SEAT}。试试： g2048 board --id ${ID} --seat ${SEAT}`)
    break
  }
  case 'watch': {
    const url = `${URL_BASE}/api/match/${needId()}/stream`
    const res = await fetch(url)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
        const line = chunk.split('\n').find((l) => l.startsWith('data: '))
        if (line) { const s = JSON.parse(line.slice(6)); console.log(JSON.stringify({ step: s.step, over: s.over, agent: s.seats.agent.game, human: s.seats.human.game })) }
      }
    }
    break
  }
  case 'state': {
    const r = await fetch(`${URL_BASE}/api/match/${needId()}`)
    out(await r.json()); break
  }
  case 'status': out((await call('status')).result); break
  case 'board': out((await call('board')).result.ascii); break
  case 'board-json': out((await call('board')).result); break
  case 'legal-moves': case 'legal_moves': {
    const r = (await call('legal_moves')).result
    out(r.ascii + '\n\n' + r.candidates.map((c) => `${c.moved ? '✔' : '✘'} ${c.dir.padEnd(5)} ${c.moved ? Math.round(c.eval) : ''}`).join('\n'))
    break
  }
  case 'eval': out((await call('eval')).result); break
  case 'search': {
    const r = (await call('search', { depth: Number(flag('depth', 3)), budget: Number(flag('budget', 20000)) })).result
    out(`best=${r.best}  eval=${r.eval}  nodes=${r.nodes}/${r.budget}  pv=${r.pv.join('')}\n` +
      r.scores.map((s) => `${s.dir.padEnd(5)} ${s.score}`).join('\n'))
    break
  }
  case 'forecast': out((await call('forecast', { n: Number(flag('n', 3)) })).result); break
  case 'turn': {
    const t = (await call('turn', {})).result
    out(`${t.locked ? '🔒' : '▶'}  ${t.reason}\n   人类 ${t.humanMoves} 步(${t.humanStatus}) | 我 ${t.agentMoves} 步(${t.agentStatus}) | 下一个动作: ${t.next === 'agent' ? 'AI' : t.next === 'human' ? '人类' : '任意'}`)
    break
  }
  case 'opponent': out((await call('opponent')).result); break
  case 'note': {
    const i = argv.indexOf('note')
    const flags = ['--url', '--id', '--seat', '--seed', '--target', '--sync', '--challenge', '--forecast-on', '--cross-seat', '--local']
    const words = []
    for (let k = i + 1; k < argv.length; k++) {
      if (flags.includes(argv[k])) { k++; continue }
      words.push(argv[k])
    }
    out((await call('note', { text: words.join(' ') })).result)
    break
  }
  case 'move': {
    const dir = pos[1] || flag('dir')
    const r = (await call('move', { dir })).result
    if (r.locked) {
      console.log(`⛓ ${dir} 被节奏锁拦住：${r.reason}`)
      console.log(`   提示：思考类工具不受锁 —— 可以先 g2048 note "我在等人类走，同时在算…"`)
      break
    }
    out(r.moved ? `✔ ${dir}  +${r.gained}  最高 ${r.maxTile}  分数 ${r.score}` : `✘ ${dir} 无效`)
    break
  }
  default:
    // 未知命令 → 当作工具名直接透传（方便 agent 脚本化）
    out((await call(cmd.replace(/-/g, '_'), {})).result)
}
