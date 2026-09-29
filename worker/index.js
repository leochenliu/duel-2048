/**
 * Worker 入口：只做路由
 *   /api/match            POST 新建一局（生成 id，把后续请求路由到对应 DO）
 *   /api/match/:id/...    转发给该局的 Durable Object
 *   其他                   交给静态资源（public/）
 */
import { MatchDO } from './match-do.js'

export { MatchDO }

const json = (data, code = 200) =>
  new Response(JSON.stringify(data), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
  })

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)

export default {
  async fetch(req, env) {
    const url = new URL(req.url)

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' },
      })
    }

    if (url.pathname === '/api/match' && req.method === 'POST') {
      const opts = await req.json().catch(() => ({}))
      const id = newId()
      const stub = env.MATCH.get(env.MATCH.idFromName(id))
      const created = await stub.fetch('https://do/new', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...opts, seed: opts.seed || id }),
      })
      const info = await created.json()
      return json({
        id,
        seed: info.seed,
        seats: ['human', 'agent'],
        hint: `g2048 join --url ${url.origin} --id ${id} --seat agent`,
      })
    }

    const m = url.pathname.match(/^\/api\/match\/([^/]+)(\/.*)?$/)
    if (m) {
      const stub = env.MATCH.get(env.MATCH.idFromName(m[1]))
      return stub.fetch(new Request(url.toString(), req))
    }

    return env.ASSETS.fetch(req)
  },
}
