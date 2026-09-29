// 权威世界：唯一写入者。浏览器（人类席）与 g2048 CLI（Agent 席）都是它的客户端。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMatch, snapshot, SEATS } from '../core/match.js'
import { runTool } from '../core/tools.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const PUBLIC = path.join(ROOT, 'public')
const PORT = Number(process.env.PORT || 5173)

/** @type {Map<string, ReturnType<typeof createMatch>>} */
const matches = new Map()
/** @type {Map<string, Set<http.ServerResponse>>} */
const clients = new Map()

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' }

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

function broadcast(match) {
  const set = clients.get(match.id)
  if (!set || !set.size) return
  const payload = `event: state\ndata: ${JSON.stringify(snapshot(match))}\n\n`
  for (const res of set) { try { res.write(payload) } catch { set.delete(res) } }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const p = url.pathname
  try {
    if (p === '/' || p === '/index.html') return sendFile(res, path.join(PUBLIC, 'index.html'))
    // 静态资源：根路径优先（与 Cloudflare Workers 静态资源行为一致），/static/ 保留兼容
    const rel = p.replace(/^\/static\//, '/').replace(/^\/assets\//, '/')
    if (rel !== p || /\.(html|js|css|svg|json|png|ico)$/.test(p)) return sendFile(res, path.join(PUBLIC, rel))

    if (req.method === 'POST' && p === '/api/match') {
      const b = await readBody(req)
      const m = createMatch(b)
      matches.set(m.id, m)
      return json(res, 200, { id: m.id, seed: m.seed, seats: SEATS, hint: `g2048 join --url http://localhost:${PORT} --id ${m.id} --seat agent` })
    }

    const mRoute = p.match(/^\/api\/match\/([^/]+)(\/.*)?$/)
    if (mRoute) {
      const m = matches.get(mRoute[1])
      if (!m) return json(res, 404, { error: 'match not found' })
      const rest = mRoute[2] || ''

      if (rest === '' && req.method === 'GET') return json(res, 200, snapshot(m))

      if (rest === '/stream' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write(`retry: 1000\n\n`)
        res.write(`event: state\ndata: ${JSON.stringify(snapshot(m))}\n\n`)
        if (!clients.has(m.id)) clients.set(m.id, new Set())
        clients.get(m.id).add(res)
        const ka = setInterval(() => { try { res.write(': ka\n\n') } catch {} }, 15000)
        req.on('close', () => { clearInterval(ka); clients.get(m.id)?.delete(res) })
        return
      }

      const tRoute = rest.match(/^\/tool\/([^/]+)$/)
      if (tRoute && req.method === 'POST') {
        const seat = tRoute[1]
        if (!SEATS.includes(seat)) return json(res, 400, { error: 'bad seat' })
        const b = await readBody(req)
        const out = await runTool(m, seat, b.tool, b.args || {})
        broadcast(m)
        return json(res, 200, out)
      }

      if (rest === '/replay' && req.method === 'GET') {
        return json(res, 200, { seed: m.seed, trace: m.trace, log: m.events, divergence: m.divergence })
      }
    }
    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: e.message, stack: e.stack?.split('\n').slice(0, 4) })
  }
})

function sendFile(res, file) {
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.writeHead(404); return res.end('404') }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(file).pipe(res)
}

server.listen(PORT, () => {
  console.log(`\n  同题异解 · 2048 双栏对战`)
  console.log(`  ─────────────────────────────────────────`)
  console.log(`  人类席（左栏）  http://localhost:${PORT}`)
  console.log(`  Agent 席接入     g2048 join --url http://localhost:${PORT} --id <matchId> --seat agent`)
  console.log(`  自动对手         npm run bot\n`)
})
