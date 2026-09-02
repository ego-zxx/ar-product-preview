// Stdlib-only API for QR access tokens + grants.
// ponytail: JSON-file store, sync writes — move to SQLite when >1 admin or
// >hundreds of grants.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { extname, basename, resolve } from 'node:path'

// Where state lives. Defaults to next to this file; set DATA_DIR to a mounted
// volume in production (Railway/Render), because a volume mounted over the
// source directory would hide server.mjs itself.
const DATA = process.env.DATA_DIR
  ? pathToFileURL(resolve(process.env.DATA_DIR) + '/')
  : new URL('./', import.meta.url)
mkdirSync(DATA, { recursive: true })
const DB = new URL('db.json', DATA)
const db = existsSync(DB)
  ? JSON.parse(readFileSync(DB, 'utf8'))
  : { adminKey: randomBytes(16).toString('hex'), tokens: [], grants: [], products: [] }
db.products ??= []
db.sessions ??= []

const UPLOADS = new URL('uploads/', DATA)
mkdirSync(UPLOADS, { recursive: true })
const MAX_UPLOAD = 60 * 1024 * 1024
const save = () => writeFileSync(DB, JSON.stringify(db, null, 2))
save()
console.log(`Admin key: ${db.adminKey}`)

const HEARTBEAT_ACTIVE_MS = 90_000
const ADMIN_SESSION_MS = 24 * 60 * 60 * 1000
const PORT = Number(process.env.PORT) || 8788

const validSession = (token) =>
  !!token && db.sessions.some((s) => s.token === token && Date.now() < s.expiresAt)

/** First non-internal IPv4 — what a phone on the same Wi-Fi can actually reach. */
const lanIp = () =>
  Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? null

const tokenById = (id) => db.tokens.find((t) => t.id === id)
const grantFor = (tokenId) => db.grants.find((g) => g.tokenId === tokenId)

function grantStatus(token) {
  const g = grantFor(token.id)
  if (token.revoked) return 'revoked'
  if (!g) return 'unclaimed'
  if (Date.now() > g.expiresAt) return 'expired'
  return 'active'
}

const routes = {
  'POST /api/admin/tokens': (body) => {
    const hours = Number(body.hours)
    if (!(hours > 0 && hours <= 720)) return [400, { error: 'hours must be 1-720' }]
    const t = {
      id: randomBytes(8).toString('hex'),
      token: randomBytes(16).toString('hex'),
      hours,
      label: String(body.label ?? '').trim().slice(0, 60),
      createdAt: Date.now(),
      revoked: false,
    }
    db.tokens.push(t)
    save()
    return [200, t]
  },
  'GET /api/admin/overview': () => {
    const now = Date.now()
    const tokens = db.tokens.map((t) => {
      const g = grantFor(t.id)
      return { ...t, status: grantStatus(t), grant: g ?? null }
    })
    const activeUsers = db.grants.filter(
      (g) =>
        now < g.expiresAt &&
        now - g.lastSeen < HEARTBEAT_ACTIVE_MS &&
        !tokenById(g.tokenId)?.revoked,
    ).length
    return [200, { tokens: tokens.reverse(), activeUsers, lanIp: lanIp() }]
  },
  'POST /api/admin/revoke': (body) => {
    const t = tokenById(body.id)
    if (!t) return [404, { error: 'no such token' }]
    t.revoked = true
    save()
    return [200, { ok: true }]
  },
  'POST /api/claim': (body) => {
    const { token, deviceId } = body
    if (!token || !deviceId) return [400, { error: 'token and deviceId required' }]
    const t = db.tokens.find((x) => x.token === token)
    if (!t || t.revoked) return [403, { error: 'Invalid or revoked QR code' }]
    let g = grantFor(t.id)
    if (g && g.deviceId !== deviceId)
      return [403, { error: 'This QR code was already used on another device' }]
    if (g && Date.now() > g.expiresAt) return [403, { error: 'Access expired' }]
    if (!g) {
      g = {
        tokenId: t.id,
        deviceId,
        claimedAt: Date.now(),
        expiresAt: Date.now() + t.hours * 3_600_000,
        lastSeen: Date.now(),
      }
      db.grants.push(g)
      save()
    }
    return [200, { expiresAt: g.expiresAt }]
  },
  'POST /api/admin/login': () => {
    db.sessions = db.sessions.filter((s) => Date.now() < s.expiresAt)
    const session = {
      token: randomBytes(24).toString('hex'),
      expiresAt: Date.now() + ADMIN_SESSION_MS,
    }
    db.sessions.push(session)
    save()
    return [200, session]
  },
  'GET /api/products': () => [200, db.products],
  'POST /api/admin/products': (body) => {
    const { name, category, url, emoji, scale, price, description, dimensions, specs } = body
    if (!name || !url) return [400, { error: 'name and url required' }]
    const p = {
      id: randomBytes(6).toString('hex'),
      name,
      category: category || 'Other',
      url,
      emoji: emoji || '\u{1F6C1}',
      scale: Number(scale) > 0 ? Number(scale) : 1,
      price: String(price ?? '').trim().slice(0, 40),
      description: String(description ?? '').trim().slice(0, 1200),
      dimensions: String(dimensions ?? '').trim().slice(0, 120),
      // free-form "Label: value" lines — covers material, finish, warranty,
      // calories, whatever a given catalogue needs, without new columns
      specs: String(specs ?? '')
        .split('\n')
        .map((line) => line.split(/:(.*)/s))
        .filter(([k, v]) => k?.trim() && v?.trim())
        .slice(0, 20)
        .map(([k, v]) => ({ label: k.trim().slice(0, 40), value: v.trim().slice(0, 80) })),
    }
    db.products.push(p)
    save()
    return [200, p]
  },
  'POST /api/admin/products/delete': (body) => {
    const i = db.products.findIndex((p) => p.id === body.id)
    if (i === -1) return [404, { error: 'no such product' }]
    const [p] = db.products.splice(i, 1)
    // only delete files we host; built-in models have non-/models urls
    if (p.url.startsWith('/models/')) {
      try {
        unlinkSync(new URL(basename(p.url), UPLOADS))
      } catch {}
    }
    save()
    return [200, { ok: true }]
  },
  'POST /api/heartbeat': (body) => {
    const { token, deviceId } = body
    const t = db.tokens.find((x) => x.token === token)
    const g = t && grantFor(t.id)
    if (!t || t.revoked || !g || g.deviceId !== deviceId)
      return [403, { valid: false, reason: 'Access revoked or invalid' }]
    if (Date.now() > g.expiresAt)
      return [403, { valid: false, reason: 'Access expired' }]
    g.lastSeen = Date.now()
    save()
    return [200, { valid: true, expiresAt: g.expiresAt }]
  },
}

const MIME = { '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.usdz': 'model/vnd.usdz+zip' }

// Split hosting: the frontend (Vercel) calls this API on another origin.
// Set ALLOWED_ORIGIN to the site's URL in production; '*' is the dev default.
const ORIGIN = process.env.ALLOWED_ORIGIN ?? '*'
const CORS = {
  'access-control-allow-origin': ORIGIN,
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type, x-admin-key, x-admin-session, x-filename',
  'access-control-max-age': '86400',
}

createServer(async (req, res) => {
  const path = req.url.split('?')[0]

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end()
    return
  }

  // serve uploaded models
  // HEAD as well as GET: AR viewers, CDNs and link previewers probe with HEAD
  // before downloading, and a 404 there can stop the model loading at all.
  if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/models/')) {
    const file = basename(path)
    try {
      const buf = readFileSync(new URL(file, UPLOADS))
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'content-length': buf.length,
        ...CORS,
      })
      // a HEAD reply carries the headers but no body
      res.end(req.method === 'HEAD' ? undefined : buf)
    } catch {
      res.writeHead(404, CORS).end('not found')
    }
    return
  }

  // raw-body model upload: PUT /api/admin/upload with x-filename header
  if (req.method === 'PUT' && path === '/api/admin/upload') {
    if (req.headers['x-admin-key'] !== db.adminKey && !validSession(req.headers['x-admin-session'])) {
      res.writeHead(401, CORS).end('{"error":"unauthorized"}')
      return
    }
    const name = basename(String(req.headers['x-filename'] ?? 'model.glb')).replace(/[^\w.-]/g, '_')
    if (!['.glb', '.gltf'].includes(extname(name).toLowerCase())) {
      res.writeHead(400, CORS).end('{"error":"only .glb or .gltf"}')
      return
    }
    const chunks = []
    let size = 0
    for await (const c of req) {
      size += c.length
      if (size > MAX_UPLOAD) {
        res.writeHead(413, CORS).end('{"error":"file too large (60MB max)"}')
        req.destroy()
        return
      }
      chunks.push(c)
    }
    const file = `${randomBytes(4).toString('hex')}-${name}`
    writeFileSync(new URL(file, UPLOADS), Buffer.concat(chunks))
    res.writeHead(200, { 'content-type': 'application/json', ...CORS })
    res.end(JSON.stringify({ url: `/models/${file}` }))
    return
  }

  let body = {}
  if (req.method === 'POST') {
    try {
      let raw = ''
      for await (const c of req) raw += c
      body = raw ? JSON.parse(raw) : {}
    } catch {
      res.writeHead(400, CORS).end('{"error":"bad json"}')
      return
    }
  }
  const handler = routes[`${req.method} ${path}`]
  if (!handler) {
    res.writeHead(404, CORS).end('{"error":"not found"}')
    return
  }
  if (path.startsWith('/api/admin/')) {
    const byKey = req.headers['x-admin-key'] === db.adminKey
    // login proves itself with the key; everything else may use a session
    const ok = byKey || (path !== '/api/admin/login' && validSession(req.headers['x-admin-session']))
    if (!ok) {
      res.writeHead(401, CORS).end('{"error":"unauthorized"}')
      return
    }
  }
  const [status, payload] = handler(body)
  res.writeHead(status, { 'content-type': 'application/json', ...CORS })
  res.end(JSON.stringify(payload))
})
  .listen(PORT, () => console.log(`API on http://localhost:${PORT}`))
