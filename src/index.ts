import { Hono } from 'hono'
import { page } from './page'

// バインディングの型は cloudflare.config.ts から生成される（npm run typecheck）
type Bindings = Cloudflare.Env

// R2のキー構成
//   books/<id>/book.pdf       取り込んだPDF
//   books/<id>/meta.json      タイトル・著者・文字数など
//   books/<id>/paras.json     本文（段落の配列）
//   books/<id>/progress.json  読書位置
//   books/<id>/img/fig-N.png  図
const ID = /^[a-z0-9]{6,24}$/
const IMG = /^fig-\d{1,4}\.png$/
const key = (id: string, name: string) => `books/${id}/${name}`

type Meta = { title: string; author: string; pages: number; chars: number; figures: number; added: number }
type Progress = { pos: number; pct: number }

async function readJson<T>(bucket: R2Bucket, k: string): Promise<T | null> {
  const o = await bucket.get(k)
  return o ? ((await o.json()) as T) : null
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => c.html(page()))

const api = new Hono<{ Bindings: Bindings }>()

api.use('/books/:id/*', async (c, next) => {
  if (!ID.test(c.req.param('id'))) return c.json({ error: 'bad id' }, 400)
  await next()
})

// 本の一覧（meta.json があるものだけ＝アップロードが完了したもの）
api.get('/books', async (c) => {
  const ids: string[] = []
  let cursor: string | undefined
  do {
    const r = await c.env.BOOKS.list({ prefix: 'books/', cursor })
    for (const o of r.objects) {
      const m = o.key.match(/^books\/([a-z0-9]+)\/meta\.json$/)
      if (m) ids.push(m[1])
    }
    cursor = r.truncated ? r.cursor : undefined
  } while (cursor)
  const books = await Promise.all(
    ids.map(async (id) => {
      const [meta, progress] = await Promise.all([
        readJson<Meta>(c.env.BOOKS, key(id, 'meta.json')),
        readJson<Progress>(c.env.BOOKS, key(id, 'progress.json')),
      ])
      return meta ? { id, ...meta, progress } : null
    })
  )
  const list = books.filter((b): b is NonNullable<typeof b> => b !== null)
  list.sort((a, b) => (b.added ?? 0) - (a.added ?? 0))
  return c.json(list)
})

// 1冊ぶん（本文・読書位置込み）
api.get('/books/:id', async (c) => {
  const id = c.req.param('id')
  const [meta, paras, progress] = await Promise.all([
    readJson(c.env.BOOKS, key(id, 'meta.json')),
    readJson(c.env.BOOKS, key(id, 'paras.json')),
    readJson(c.env.BOOKS, key(id, 'progress.json')),
  ])
  if (!meta || !paras) return c.json({ error: 'not found' }, 404)
  return c.json({ id, meta, paras, progress })
})

// アップロード（クライアントで解析した結果を置く。meta.json は最後に送る）
api.put('/books/:id/pdf', async (c) => {
  await c.env.BOOKS.put(key(c.req.param('id'), 'book.pdf'), await c.req.arrayBuffer(), {
    httpMetadata: { contentType: 'application/pdf' },
  })
  return c.json({ ok: true })
})
api.put('/books/:id/img/:name', async (c) => {
  const name = c.req.param('name')
  if (!IMG.test(name)) return c.json({ error: 'bad name' }, 400)
  await c.env.BOOKS.put(key(c.req.param('id'), `img/${name}`), await c.req.arrayBuffer(), {
    httpMetadata: { contentType: 'image/png' },
  })
  return c.json({ ok: true })
})
for (const name of ['paras', 'meta', 'progress'] as const) {
  api.put(`/books/:id/${name}`, async (c) => {
    const text = await c.req.text()
    try { JSON.parse(text) } catch { return c.json({ error: 'bad json' }, 400) }
    await c.env.BOOKS.put(key(c.req.param('id'), `${name}.json`), text, {
      httpMetadata: { contentType: 'application/json' },
    })
    return c.json({ ok: true })
  })
}

// 図とPDFの配信
api.get('/books/:id/img/:name', async (c) => {
  const name = c.req.param('name')
  if (!IMG.test(name)) return c.json({ error: 'bad name' }, 400)
  const o = await c.env.BOOKS.get(key(c.req.param('id'), `img/${name}`))
  if (!o) return c.notFound()
  return new Response(o.body, {
    headers: { 'content-type': 'image/png', etag: o.httpEtag, 'cache-control': 'private, max-age=31536000, immutable' },
  })
})
api.get('/books/:id/pdf', async (c) => {
  const o = await c.env.BOOKS.get(key(c.req.param('id'), 'book.pdf'))
  if (!o) return c.notFound()
  return new Response(o.body, { headers: { 'content-type': 'application/pdf', etag: o.httpEtag } })
})

// 削除（その本のキーをすべて消す）
api.delete('/books/:id', async (c) => {
  const prefix = `books/${c.req.param('id')}/`
  let cursor: string | undefined
  do {
    const r = await c.env.BOOKS.list({ prefix, cursor })
    if (r.objects.length) await c.env.BOOKS.delete(r.objects.map((o) => o.key))
    cursor = r.truncated ? r.cursor : undefined
  } while (cursor)
  return c.json({ ok: true })
})

app.route('/api', api)

export default app
