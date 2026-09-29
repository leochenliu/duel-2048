// 前端：只做渲染 + 发意图。所有状态由服务器权威持有（单一事实源）。
const $ = (s) => document.querySelector(s)
const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e }

let matchId = null
let snap = null
let es = null
let prev = { human: [], agent: [] }

const COLORS = {
  2: '#eee4da', 4: '#ede0c8', 8: '#f2b179', 16: '#f59563', 32: '#f67c5f',
  64: '#f65e3b', 128: '#edcf72', 256: '#edcc61', 512: '#edc850', 1024: '#edc53f',
  2048: '#edc22e', 4096: '#3c3a32', 8192: '#3c3a32', 16384: '#3c3a32',
}
const color = (v) => COLORS[v] || '#3c3a32'
const DIR_CN = { up: '↑ 上', down: '↓ 下', left: '← 左', right: '→ 右' }
const coord = (i) => `${'ABC D'.replace(/ /g, '')[i % 4]}${(i / 4 | 0) + 1}`

// ---------------- 建局 ----------------
async function newMatch() {
  const body = {
    seed: $('#seed').value.trim() || String(Date.now()),
    target: 2048,
    sync: $('#sync').value,
    pace: $('#pace').value,
    forecastOn: $('#forecast').checked,
    crossSeat: false,
  }
  const r = await fetch('/api/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json()
  matchId = j.id
  location.hash = matchId
  prev = { human: [], agent: [] }
  $('#humanProcess').innerHTML = ''
  $('#agentProcess').innerHTML = ''
  attach()
}

function attach() {
  if (es) es.close()
  es = new EventSource(`/api/match/${matchId}/stream`)
  es.addEventListener('state', (ev) => { snap = JSON.parse(ev.data); render() })
}

// ---------------- 交互 ----------------
async function tool(seat, tool, args) {
  const r = await fetch(`/api/match/${matchId}/tool/${seat}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, args }),
  })
  return r.json()
}

const KEYMAP = { ArrowUp: 'up', w: 'up', W: 'up', ArrowDown: 'down', s: 'down', S: 'down', ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right' }
addEventListener('keydown', (e) => {
  if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') {
    if (e.key === 'Escape') document.activeElement.blur()
    return
  }
  const dir = KEYMAP[e.key]
  if (dir) { e.preventDefault(); tool('human', 'move', { dir }) }
  if (e.key === '/') { e.preventDefault(); $('#humanNoteText').focus() }
})
document.querySelectorAll('.dpad button').forEach((b) => b.addEventListener('click', () => tool('human', 'move', { dir: b.dataset.dir })))
$('#humanNote').addEventListener('submit', (e) => {
  e.preventDefault()
  const t = $('#humanNoteText').value.trim()
  if (t) tool('human', 'note', { text: t })
  $('#humanNoteText').value = ''
})
$('#newBtn').addEventListener('click', newMatch)
$('#botBtn').addEventListener('click', () => runBot('agent'))
$('#botHumanBtn').addEventListener('click', () => runBot('human'))

/** 内置 AI：完全通过同一套工具接口驱动（与外部 agent 无差别），并遵守节奏锁 */
async function runBot(seat = 'agent') {
  const depth = Number(localStorage.getItem('botDepth') || 3)
  const call = (t, a = {}) => tool(seat, t, a)
  for (let i = 0; i < 20000; i++) {
    const t = await call('turn')
    if (!t.ok) break
    if (!t.result.youCanMove) { await new Promise((r) => setTimeout(r, 200)); continue }
    const st = await call('status')
    const me = st.result.seats[seat]
    if (me.status !== 'playing') break
    const bd = await call('board')
    const fc = await call('forecast', { n: 2 })
    const sr = await call('search', { depth, budget: 20000 })
    if (!sr.ok || !sr.result.best) break
    const v = bd.result.view
    const empties = v.grid.filter((x) => !x).length
    const mi = v.grid.indexOf(v.maxTile)
    const corner = [0, 3, 12, 15].includes(mi)
    const f = fc.ok && fc.result.on ? fc.result.events[0] : null
    await call('note', { text: `空格${empties}；${corner ? '最大值已锁角落' : '最大值偏离角落'}；走${sr.result.best}(${sr.result.nodes}节点)${f ? `；预报下块 ${f.value}@${coord(f.cell)}` : ''}` })
    const mv = await call('move', { dir: sr.result.best })
    if (!mv.ok) break
    if (mv.result.locked) { await new Promise((r) => setTimeout(r, 200)); continue }
    if (!mv.result.moved) break
    await new Promise((r) => setTimeout(r, 120))
  }
}

// ---------------- 渲染 ----------------
function render() {
  if (!snap) return
  const { seats, divergence } = snap
  $('#meta').innerHTML = [
    `id <b>${snap.id}</b>`, `seed <b>${snap.seed}</b>`, `同步 <b>${{ strict: '严格', value: '仅数值', none: '独立' }[snap.sync]}</b>`,
    `总步 <b>${snap.step}</b>`, `预报 <b>${snap.forecastOn ? '开' : '关'}</b>`,
  ].map((s) => `<span>${s}</span>`).join('')

  drawBoard('#humanBoard', seats.human.game, 'human')
  drawBoard('#agentBoard', seats.agent.game, 'agent')
  $('#humanStatus').textContent = seats.human.game.status
  $('#agentStatus').textContent = seats.agent.game.status
  $('#agentStatus').className = 'badge ' + seats.agent.game.status
  $('#humanStatus').className = 'badge ' + seats.human.game.status
  $('#overBadge').textContent = snap.over ? `结束 · ${snap.winner === 'draw' ? '平局' : snap.winner === 'human' ? '人类胜' : 'Agent 胜'}` : `进行中 · ${snap.step} 步`
  $('#overBadge').className = 'badge ' + (snap.over ? 'lost' : 'playing')

  for (const seat of ['human', 'agent']) {
    const g = seats[seat].game
    $('#' + seat + 'Stats').innerHTML = [
      ['分数', g.score], ['步数', g.moves], ['最高', g.maxTile], ['空格', g.grid.filter((x) => !x).length],
    ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')
  }

  // 过程流（两栏同格式，公平对照）
  renderTrace('#humanProcess', snap.trace, 'human')
  renderTrace('#agentProcess', snap.trace, 'agent')
  $('#agentBudget').textContent = `${seats.agent.stats.toolCalls} 次调用 · ${Math.round(seats.agent.stats.readMs)}ms 算力`

  // 节奏锁 + 分岔
  const L = snap.lock || { mode: 'lock', locked: false, next: 'any', humanMoves: 0, agentMoves: 0 }
  $('#lockVal').textContent = L.mode === 'free' ? '自由模式' : L.locked ? '🔒 等你走' : '▶ AI 的回合'
  $('#lockVal').style.color = L.mode === 'free' ? 'var(--dim)' : L.locked ? 'var(--warn)' : 'var(--shared)'
  $('#lockNote').textContent = L.mode === 'free'
    ? 'AI 按自己的节奏走，不受限制'
    : L.locked
      ? 'AI 不能领先你一步（思考不受锁：它仍可 board / search / note）'
      : `人类 ${L.humanMoves} 步 · AI ${L.agentMoves} 步 —— AI 走完这步就停下等你`

  if (divergence.firstLayout) {
    $('#divVal').textContent = `第 ${divergence.firstLayout.step} 步起分岔`
    $('#divNote').textContent = divergence.firstValue
      ? `第 ${divergence.firstValue.step} 步起，连"手上有什么方块"都不一样了。`
      : '两边方块集合仍相同 —— 只是摆放不同，纯策略差异。'
  } else {
    $('#divVal').textContent = divergence.commonSteps ? `已同步 ${divergence.commonSteps} 步` : '尚未分岔'
    $('#divNote').textContent = '两个座位消费同一条事件流；差异只来自决策'
  }

  // 上一步对照：把"我的走法 vs AI 的走法"直接摆在一起
  const hm = seats.human.game.lastMove, am = seats.agent.game.lastMove
  if (hm && am) {
    const same = hm === am
    $('#cmpVal').innerHTML = `你 <b style="color:var(--human)">${DIR_CN[hm]}</b> → AI <b style="color:var(--agent)">${DIR_CN[am]}</b>`
    $('#cmpNote').innerHTML = same
      ? '方向相同 —— 但落子后局面已经不同（这是分岔的起点）'
      : '方向就不同 —— 同一条事件流，两种解题思路'
  } else if (hm) {
    $('#cmpVal').textContent = `你走了 ${DIR_CN[hm]}`
    $('#cmpNote').textContent = '等 AI 走它的这一步'
  }

  // 预报
  const fc = snap.forecast
  $('#fcRow').innerHTML = fc && fc.length
    ? fc.map((e) => `<div class="fc"><div class="v">${e.value}</div><div class="c">${coord(e.cell)}</div></div>`).join('')
    : '<div class="fc">预报已关闭</div>'

  // 事件流对照
  const hs = seats.human.game.spawned, as = seats.agent.game.spawned
  const n = Math.max(hs.length, as.length)
  const rows = []
  for (let i = n - 1; i >= 0; i--) {
    const h = hs[hs.length - n + i], a = as[as.length - n + i]
    if (!h && !a) continue
    const t = (h || a).ticket
    const hc = h ? coord(h.landed) : '—', ac = a ? coord(a.landed) : '—'
    const diff = h && a && h.landed !== a.landed
    rows.push(`<tr><td>${t}</td><td>${(h || a).value}</td><td class="${diff ? 'diff' : ''}">${hc}</td><td class="${diff ? 'diff' : ''}">${ac}</td></tr>`)
  }
  $('#streamTable tbody').innerHTML = rows.join('') || '<tr><td colspan="4">尚无落子</td></tr>'

  $('#joinBox').innerHTML = `让任意 Agent（pi / claude code / 脚本）接管右栏：<br>
<b>g2048 join --id ${matchId} --seat agent</b><br>
<b>g2048 board</b> · <b>g2048 forecast</b> · <b>g2048 search --depth 3</b> · <b>g2048 note "..."</b> · <b>g2048 move left</b>`
}

function drawBoard(sel, g, seat) {
  const box = $(sel)
  const old = prev[seat] || []
  const cells = g.grid
  if (box.children.length !== 16) { box.innerHTML = ''; for (let i = 0; i < 16; i++) box.appendChild(el('div', 'cell')) }
  ;[...box.children].forEach((c, i) => {
    const v = cells[i]
    c.textContent = v || ''
    c.style.background = v ? color(v) : ''
    c.className = 'cell' + (v && v !== old[i] ? ' pop' : '')
  })
  prev[seat] = cells.slice()
}

function renderTrace(sel, trace, seat) {
  const box = $(sel)
  const items = trace.filter((t) => t.seat === seat && t.kind !== 'meta')
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  box.innerHTML = ''
  for (const t of items.slice(-60)) {
    const e = el('div', 'ev ' + t.kind + (t.ok ? '' : ' err'))
    const head = el('div')
    head.innerHTML = `<span class="tool">${t.kind === 'move' ? 'move' : t.tool}</span>` +
      (t.args && Object.keys(t.args).length ? ` <span class="args">${Object.entries(t.args).map(([k, v]) => `${k}=${v}`).join(' ')}</span>` : '') +
      (t.ms ? ` <span class="sum">${t.ms}ms</span>` : '')
    e.appendChild(head)
    if (t.kind === 'note') e.className = 'ev note'
    if (t.tool === 'search' && t.data?.scores) {
      const best = t.data.best
      const line = el('div', 'sum')
      line.innerHTML = t.data.scores.map((s) => `<span class="cand ${s.dir === best ? 'best' : ''}">${s.dir} ${s.score}</span>`).join('')
      e.appendChild(line)
    }
    if (t.kind === 'move' && t.data?.reasoning?.length && seat === 'human') {
      e.appendChild(el('div', 'sum', `（用了 ${t.data.reasoning.length} 次思考/查询才落子）`))
    }
    if (t.summary) e.appendChild(el('div', 'sum', t.summary))
    box.appendChild(e)
  }
  if (atBottom) box.scrollTop = box.scrollHeight
}

// ---------------- 启动 ----------------
;(async () => {
  const hash = location.hash.slice(1)
  if (hash) { matchId = hash; attach() } else await newMatch()
})()
