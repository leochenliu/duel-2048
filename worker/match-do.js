/**
 * Durable Object：每一局对局的权威世界
 * ---------------------------------------------------------------
 * 为什么必须有 DO：match 里有两个座位、一条共享事件流、一份过程留痕，
 * 必须是单一写入者。Workers 每个请求的 isolate 都是独立的，
 * 只有 DO 才能提供"按 id 路由到唯一实例 + 顺序执行 + 可持久化"这三件套。
 *
 * 状态落盘：每次变更后写入 DO storage，实例被回收后仍能恢复。
 * 规模控制：trace 只留最近 150 条（UI 只用最后 120 条），远小于 128KB 值上限。
 */
import { createMatch, snapshot, SEATS } from '../src/core/match.js'
import { runTool } from '../src/core/tools.js'

const TRACE_KEEP = 150
const EVENT_KEEP = 200
const REASONING_KEEP = 3
const encoder = new TextEncoder()

/** 裁剪：让 match 永远小于 DO storage 的单值上限 */
function compact(m) {
  if (m.trace.length > TRACE_KEEP) m.trace.splice(0, m.trace.length - TRACE_KEEP)
  if (m.events.length > EVENT_KEEP) m.events.splice(0, m.events.length - EVENT_KEEP)
  for (const t of m.trace) {
    if (t.kind === 'move' && t.data?.reasoning?.length > REASONING_KEEP) {
      t.data.reasoning = t.data.reasoning.slice(-REASONING_KEEP)
    }
  }
  return m
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
}
const json = (data, code = 200) =>
  new Response(JSON.stringify(data), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
  })

export class MatchDO {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.clients = new Set()
    // 加载完成前不接请求，避免两个并发请求各自建一局
    this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get('match')
      this.match = saved || createMatch({ seed: String(Date.now()) })
      await this.persist()
    })
  }

  async persist() {
    compact(this.match)
    await this.state.storage.put('match', this.match)
  }

  broadcast() {
    if (!this.clients.size) return
    const payload = `event: state\ndata: ${JSON.stringify(snapshot(this.match))}\n\n`
    for (const send of this.clients) send(payload)
  }

  /** SSE：把这一局的快照持续推给所有连着的客户端 */
  stream() {
    const self = this
    let send, ka
    const body = new ReadableStream({
      start(controller) {
        const enqueue = (s) => { try { controller.enqueue(encoder.encode(s)) } catch { /* 客户端已断开 */ } }
        send = (s) => enqueue(s)
        self.clients.add(send)
        enqueue(`retry: 1000\n\n`)
        enqueue(`event: state\ndata: ${JSON.stringify(snapshot(self.match))}\n\n`)
        ka = setInterval(() => enqueue(': ka\n\n'), 20000)
      },
      cancel() {
        if (send) self.clients.delete(send)
        if (ka) clearInterval(ka)
      },
    })
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', ...CORS },
    })
  }

  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname
    try {
      if (p.endsWith('/stream')) return this.stream()
      if (p.endsWith('/replay')) return json({ seed: this.match.seed, trace: this.match.trace, log: this.match.events, divergence: this.match.divergence })

      const t = p.match(/\/tool\/([^/]+)$/)
      if (t && req.method === 'POST') {
        const seat = t[1]
        if (!SEATS.includes(seat)) return json({ error: 'bad seat' }, 400)
        const body = await req.json().catch(() => ({}))
        const out = await runTool(this.match, seat, body.tool, body.args || {})
        await this.persist()
        this.broadcast()
        return json(out)
      }

      if (req.method === 'POST' && p.endsWith('/new')) {
        const opts = await req.json().catch(() => ({}))
        this.match = createMatch(opts)
        await this.persist()
        this.broadcast()
        return json({ id: this.match.id, seed: this.match.seed })
      }

      return json(snapshot(this.match))
    } catch (e) {
      return json({ error: e.message, stack: String(e.stack || '').split('\n').slice(0, 4) }, 500)
    }
  }
}
