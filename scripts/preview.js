// 抓双栏节奏锁的真实截图 → docs/assets/preview.png
// 玩法：起一局 → 走 4 步人类 + 4 步 AI → 用 Playwright 等 SSE 推过来 → 截图
//
// 用法：先 node src/server/server.js（或 wrangler dev），然后
//       PORT=5173 node scripts/preview.js
// 产物：docs/assets/preview.png（高分辨率，2x DPR）+ preview-cell.png（窄屏预览）
import { chromium } from 'playwright'
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'docs/assets')
const URL = process.env.URL || `http://localhost:${process.env.PORT || 5173}`

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return r.json()
}

async function get(url) {
  const r = await fetch(url)
  return r.json()
}

// 1) 建一局锁步
const { id: matchId } = await post(URL + '/api/match', { seed: 'preview', pace: 'lock', sync: 'strict' })
console.log('match', matchId)

// 2) 自动推一段剧情：人类走 5 步（顺便带 note），AI 用内置搜索走 5 步
const DIRS = ['left', 'down', 'right', 'down', 'left']
for (let i = 0; i < 5; i++) {
  // 人类先走
  const hm = await post(`${URL}/api/match/${matchId}/tool/human`, { tool: 'move', args: { dir: DIRS[i] } })
  // AI 醒过来：等节奏锁 → search → note → move
  await post(`${URL}/api/match/${matchId}/tool/agent`, { tool: 'search', args: { depth: 3, budget: 15000 } })
  await post(`${URL}/api/match/${matchId}/tool/agent`, { tool: 'note', args: { text: `第 ${i + 1} 步：空格收紧，先保住右下次序` } })
  const am = await post(`${URL}/api/match/${matchId}/tool/agent`, { tool: 'move', args: { dir: ['down', 'right', 'up', 'left', 'down'][i] } })
  // 演示 lock：故意试一次抢跑，留痕
  if (i === 1) await post(`${URL}/api/match/${matchId}/tool/agent`, { tool: 'move', args: { dir: 'up' } })
  if (!hm.result?.moved || !am.result?.moved) console.warn(`step ${i + 1}: human ${hm.result?.moved} agent ${am.result?.moved}`)
}
console.log('驱动完成')

// 3) 打开浏览器
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage({
  viewport: { width: 1400, height: 900 },
  deviceScaleFactor: 2,
})
await page.goto(`${URL}/#${matchId}`, { waitUntil: 'networkidle', timeout: 30000 })
// 等棋盘渲染出来 + 过程流至少有一条 AI 记录
await page.waitForSelector('.cell', { timeout: 10000 })
await page.waitForFunction(() => {
  const proc = document.querySelector('#agentProcess')
  return proc && proc.children.length >= 8
}, { timeout: 15000 })
// 再等一拍让"节奏锁仪表"和"事件流对照"全部到位
await page.waitForTimeout(400)

// 4) 截图
await page.screenshot({ path: path.join(OUT, 'preview.png'), fullPage: false })
console.log('保存 preview.png')

// 窄版（用于 README 顶部裁切的对比图）
const phone = await browser.newPage({
  viewport: { width: 900, height: 700 },
  deviceScaleFactor: 2,
})
await phone.goto(`${URL}/#${matchId}`, { waitUntil: 'networkidle' })
await phone.waitForSelector('.cell', { timeout: 10000 })
await phone.waitForTimeout(400)
await phone.screenshot({ path: path.join(OUT, 'preview-wide.png'), fullPage: false })

await browser.close()

const cur = await get(`${URL}/api/match/${matchId}`)
console.log(`人类 ${cur.seats.human.game.moves} 步  AI ${cur.seats.agent.game.moves} 步  最高 ${Math.max(cur.seats.human.game.maxTile, cur.seats.agent.game.maxTile)}`)
console.log('✓ 截图完成')