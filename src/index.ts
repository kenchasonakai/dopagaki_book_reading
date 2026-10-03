import { Hono } from 'hono'
import { page } from './page'

// バインディングの型は cloudflare.config.ts から生成される（npm run typecheck）
type Bindings = Cloudflare.Env

// R2のキー構成
//   books/<id>/book.pdf       取り込んだPDF
//   books/<id>/meta.json      タイトル・著者・文字数など
//   books/<id>/paras.json     本文（段落の配列）
//   books/<id>/progress.json  読書位置
//   books/<id>/img/fig-N.png  図（大きいものは .jpg）
const ID = /^[a-z0-9]{6,24}$/
const IMG = /^fig-\d{1,4}\.(png|jpg)$/
const key = (id: string, name: string) => `books/${id}/${name}`

type Meta = { title: string; author: string; pages: number; chars: number; figures: number; added: number }
type Progress = { pos: number; pct: number }
type Para = { text: string; heading?: boolean; img?: string }

// 受け付けるサイズの上限（1冊ぶん）
const MAX_PDF = 60 * 1024 * 1024
const MAX_IMG = 8 * 1024 * 1024
const MAX_JSON = 8 * 1024 * 1024
const MAX_PARAS = 20000
const MAX_TEXT = 4000

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const validators: Record<'paras' | 'meta' | 'progress', (v: unknown) => boolean> = {
  paras: (v) =>
    Array.isArray(v) && v.length <= MAX_PARAS &&
    v.every((p: Para) => p && typeof p === 'object' && isStr(p.text, MAX_TEXT) &&
      (p.heading === undefined || typeof p.heading === 'boolean') &&
      (p.img === undefined || (typeof p.img === 'string' && IMG.test(p.img)))),
  meta: (v) => {
    const m = v as Meta
    return !!m && typeof m === 'object' && isStr(m.title, 300) && isStr(m.author, 300) &&
      isNum(m.pages) && isNum(m.chars) && isNum(m.figures) && isNum(m.added)
  },
  progress: (v) => { const p = v as Progress; return !!p && typeof p === 'object' && isNum(p.pos) && isNum(p.pct) && p.pct <= 100 },
}

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

// 本文を受け取る前に Content-Length で上限を確認する
async function readBody(c: { req: { header: (n: string) => string | undefined; arrayBuffer: () => Promise<ArrayBuffer> } }, max: number) {
  const len = Number(c.req.header('content-length') ?? 0)
  if (len > max) return null
  const buf = await c.req.arrayBuffer()
  return buf.byteLength > max ? null : buf
}

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
  const buf = await readBody(c, MAX_PDF)
  if (!buf) return c.json({ error: 'too large' }, 413)
  if (new TextDecoder().decode(buf.slice(0, 5)) !== '%PDF-') return c.json({ error: 'not a pdf' }, 400)
  await c.env.BOOKS.put(key(c.req.param('id'), 'book.pdf'), buf, { httpMetadata: { contentType: 'application/pdf' } })
  return c.json({ ok: true })
})
const IMG_SIG: Record<string, number[]> = { png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff] }
const imgType = (name: string) => (name.endsWith('.jpg') ? 'image/jpeg' : 'image/png')
api.put('/books/:id/img/:name', async (c) => {
  const name = c.req.param('name')
  if (!IMG.test(name)) return c.json({ error: 'bad name' }, 400)
  const buf = await readBody(c, MAX_IMG)
  if (!buf) return c.json({ error: 'too large' }, 413)
  const sig = IMG_SIG[name.slice(-3)], head = new Uint8Array(buf, 0, sig.length)
  if (!sig.every((b, i) => head[i] === b)) return c.json({ error: 'not an image' }, 400)
  await c.env.BOOKS.put(key(c.req.param('id'), `img/${name}`), buf, { httpMetadata: { contentType: imgType(name) } })
  return c.json({ ok: true })
})
for (const name of ['paras', 'meta', 'progress'] as const) {
  api.put(`/books/:id/${name}`, async (c) => {
    const buf = await readBody(c, MAX_JSON)
    if (!buf) return c.json({ error: 'too large' }, 413)
    const text = new TextDecoder().decode(buf)
    let v: unknown
    try { v = JSON.parse(text) } catch { return c.json({ error: 'bad json' }, 400) }
    if (!validators[name](v)) return c.json({ error: 'bad shape' }, 400)
    await c.env.BOOKS.put(key(c.req.param('id'), `${name}.json`), text, { httpMetadata: { contentType: 'application/json' } })
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
    headers: { 'content-type': imgType(name), etag: o.httpEtag, 'cache-control': 'private, max-age=31536000, immutable' },
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
