import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { Product } from './products'
import { api as apiUrl } from './api'
import { useConfirm } from './Confirm'

const TrashIcon = () => (
  <svg viewBox="0 0 256 256" aria-hidden="true">
    <path d="M216 48h-40v-8a24 24 0 0 0-24-24h-48a24 24 0 0 0-24 24v8H40a8 8 0 0 0 0 16h8v144a16 16 0 0 0 16 16h128a16 16 0 0 0 16-16V64h8a8 8 0 0 0 0-16ZM96 40a8 8 0 0 1 8-8h48a8 8 0 0 1 8 8v8H96Zm96 168H64V64h128Zm-80-104v64a8 8 0 0 1-16 0v-64a8 8 0 0 1 16 0Zm48 0v64a8 8 0 0 1-16 0v-64a8 8 0 0 1 16 0Z" />
  </svg>
)

const UploadIcon = () => (
  <svg viewBox="0 0 256 256" aria-hidden="true">
    <path d="M224 152v56a16 16 0 0 1-16 16H48a16 16 0 0 1-16-16v-56a8 8 0 0 1 16 0v56h160v-56a8 8 0 0 1 16 0ZM93.66 77.66 120 51.31V144a8 8 0 0 0 16 0V51.31l26.34 26.35a8 8 0 0 0 11.32-11.32l-40-40a8 8 0 0 0-11.32 0l-40 40a8 8 0 0 0 11.32 11.32Z" />
  </svg>
)

type TokenRow = {
  id: string
  token: string
  hours: number
  label?: string
  createdAt: number
  revoked: boolean
  status: 'unclaimed' | 'active' | 'expired' | 'revoked'
  grant: { claimedAt: number; expiresAt: number; lastSeen: number } | null
}

const statusColor: Record<TokenRow['status'], string> = {
  unclaimed: 'var(--label-2)',
  active: 'var(--green)',
  expired: 'var(--orange)',
  revoked: 'var(--red)',
}

export function Admin() {
  const [key, setKey] = useState('')
  const [session, setSession] = useState<{ token: string; expiresAt: number } | null>(() => {
    try {
      const s = JSON.parse(localStorage.getItem('adminSession') ?? 'null')
      return s && Date.now() < s.expiresAt ? s : null
    } catch {
      return null
    }
  })
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [loginError, setLoginError] = useState('')
  const [tab, setTab] = useState<'access' | 'products'>('access')
  const [tokens, setTokens] = useState<TokenRow[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [activeUsers, setActiveUsers] = useState(0)
  const [hours, setHours] = useState(24)
  const [label, setLabel] = useState('')
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [form, setForm] = useState({ name: '', category: 'Faucets', emoji: '🚰', scale: '1' })
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [confirm, confirmDialog] = useConfirm()
  const [linkBase, setLinkBase] = useState(localStorage.getItem('linkBase') ?? '')
  const [qrUrl, setQrUrl] = useState('')

  const api = (path: string, init?: RequestInit) =>
    fetch(apiUrl(path), {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-admin-session': session?.token ?? '',
        ...init?.headers,
      },
    })

  const signOut = () => {
    localStorage.removeItem('adminSession')
    setSession(null)
    setAuthed(false)
  }

  const signIn = async () => {
    setLoginError('')
    const res = await fetch(apiUrl('/api/admin/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
    })
    if (!res.ok) return setLoginError('That key was not accepted.')
    const s = await res.json()
    localStorage.setItem('adminSession', JSON.stringify(s))
    localStorage.removeItem('adminKey') // don't keep the root credential around
    setKey('')
    setSession(s)
  }

  const refresh = async () => {
    let res: Response
    try {
      res = await api('/api/admin/overview')
    } catch {
      return // server blip — keep the session, try again on the next poll
    }
    if (res.status === 401) return signOut()
    if (!res.ok) return // transient server error; stay signed in
    const data = await res.json()
    setAuthed(true)
    setTokens(data.tokens)
    setActiveUsers(data.activeUsers)
    // A QR pointing at localhost is unreachable from a phone — default to the
    // machine's LAN address on the HTTPS port instead.
    setLinkBase((b) => {
      if (b) return b
      const local = ['localhost', '127.0.0.1'].includes(location.hostname)
      return local && data.lanIp ? `https://${data.lanIp}:5173` : location.origin
    })
    setProducts(await (await fetch(apiUrl('/api/products'))).json())
  }

  useEffect(() => {
    if (!session) return setAuthed(false)
    refresh()
    const t = setInterval(refresh, 5000)
    // expire exactly when the session does, without waiting for a poll
    const expiry = setTimeout(signOut, Math.max(0, session.expiresAt - Date.now()))
    return () => {
      clearInterval(t)
      clearTimeout(expiry)
    }
  }, [session])

  const showQr = async (token: string) => {
    const url = `${linkBase.replace(/\/$/, '')}/?t=${token}`
    setQrUrl(url)
    setQr(await QRCode.toDataURL(url, { width: 340, margin: 2 }))
  }

  const createToken = async () => {
    const res = await api('/api/admin/tokens', {
      method: 'POST',
      body: JSON.stringify({ hours, label }),
    })
    if (res.ok) {
      await showQr((await res.json()).token)
      setLabel('')
      refresh()
    }
  }

  const addProduct = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file || !form.name) return
    setBusy('Uploading…')
    try {
      const up = await fetch(apiUrl('/api/admin/upload'), {
        method: 'PUT',
        headers: { 'x-admin-key': key, 'x-filename': file.name },
        body: file,
      })
      const upJson = await up.json()
      if (!up.ok) throw new Error(upJson.error)
      const res = await api('/api/admin/products', {
        method: 'POST',
        body: JSON.stringify({ ...form, url: upJson.url }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      setForm({ name: '', category: form.category, emoji: form.emoji, scale: '1' })
      if (fileRef.current) fileRef.current.value = ''
      setFileName('')
      setBusy('')
      refresh()
    } catch (e) {
      setBusy((e as Error).message)
    }
  }

  if (authed === false)
    return (
      <div className="page" style={{ maxWidth: 380, paddingTop: '18vh' }}>
        <h1 className="title">Admin</h1>
        <p className="sub" style={{ marginBottom: 16 }}>
          Enter the admin key printed in the server terminal at startup.
        </p>
        <input
          className="field"
          type="password"
          placeholder="Admin key"
          value={key}
          autoComplete="current-password"
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && key && signIn()}
        />
        {loginError && (
          <p className="sub" style={{ color: 'var(--red)', marginTop: 10 }}>
            {loginError}
          </p>
        )}
        <button className="btn" style={{ marginTop: 12 }} disabled={!key} onClick={signIn}>
          Sign in
        </button>
        <p className="sub" style={{ marginTop: 14 }}>
          Stays signed in for 24 hours.
        </p>
      </div>
    )

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 className="title" style={{ marginBottom: 10 }}>
          Admin
        </h1>
        <span className="badge" style={{ color: 'var(--green)' }}>● {activeUsers} active</span>
      </div>

      {session && (
        <div className="group" style={{ marginBottom: 6 }}>
          <div className="row">
            <div className="row-main">
              <div className="row-title">Signed in</div>
              <div className="row-sub">
                Session ends {new Date(session.expiresAt).toLocaleString()}
              </div>
            </div>
            <button className="row-action" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      )}

      <div className="seg">
        <button data-on={tab === 'access'} onClick={() => setTab('access')}>
          Access
        </button>
        <button data-on={tab === 'products'} onClick={() => setTab('products')}>
          Products
        </button>
      </div>

      {tab === 'access' ? (
        <>
          <div className="group">
            <div className="row" style={{ display: 'block' }}>
              <div className="row-title" style={{ marginBottom: 3 }}>Name</div>
              <div className="row-sub" style={{ marginBottom: 9 }}>
                So you can tell passes apart — a customer, a room, a showroom visit.
              </div>
              <input
                className="field"
                placeholder="e.g. Mr Sharma — Tuesday visit"
                value={label}
                maxLength={60}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="row">
              <div className="row-main">
                <div className="row-title">Duration</div>
                <div className="row-sub">Clock starts when the QR is first scanned</div>
              </div>
              <input
                className="field"
                style={{ width: 78, textAlign: 'center' }}
                type="number"
                min={1}
                max={720}
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
              />
              <span className="row-val">hrs</span>
            </div>
          </div>
          <div className="group" style={{ marginTop: 12 }}>
            <div className="row" style={{ display: 'block' }}>
              <div className="row-title" style={{ marginBottom: 3 }}>Link the QR points to</div>
              <div className="row-sub" style={{ marginBottom: 9 }}>
                Must be reachable from the phone — a LAN address or tunnel URL, not localhost.
              </div>
              <input
                className="field"
                value={linkBase}
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => {
                  setLinkBase(e.target.value)
                  localStorage.setItem('linkBase', e.target.value)
                }}
              />
            </div>
          </div>
          <button
            className="btn"
            style={{ marginTop: 12 }}
            disabled={!linkBase}
            onClick={createToken}
          >
            Generate QR code
          </button>

          {qr && (
            <div className="group" style={{ marginTop: 14, padding: 18, textAlign: 'center' }}>
              <img src={qr} alt="access QR" style={{ width: '100%', maxWidth: 300, borderRadius: 12 }} />
              <p className="sub" style={{ margin: '12px 0 4px' }}>
                One QR, one device. Locks to the first phone that scans it.
              </p>
              <p className="qr-url">{qrUrl}</p>
              <button className="btn-ghost" onClick={() => setQr(null)}>
                Close
              </button>
            </div>
          )}

          <div className="hdr">Passes</div>
          <div className="group">
            {tokens.map((t) => (
              <div className="row" key={t.id}>
                <div className="row-main">
                  <div className="row-title">
                    {t.label || <span style={{ color: 'var(--label-3)' }}>Unnamed pass</span>}
                  </div>
                  <div className="row-sub" style={{ color: statusColor[t.status] }}>
                    {t.status}
                  </div>
                  <div className="row-sub">
                    {t.hours}h ·{' '}
                    {t.grant
                      ? t.status === 'active'
                        ? `expires ${new Date(t.grant.expiresAt).toLocaleString()}`
                        : `claimed ${new Date(t.grant.claimedAt).toLocaleString()}`
                      : `created ${new Date(t.createdAt).toLocaleString()}`}
                  </div>
                </div>
                {t.status === 'unclaimed' && (
                  <button className="row-action" onClick={() => showQr(t.token)}>
                    QR
                  </button>
                )}
                {!t.revoked && (
                  <button
                    className="row-action"
                    data-danger="true"
                    onClick={async () => {
                      const ok = await confirm({
                        title: 'Revoke this pass?',
                        message:
                          t.status === 'active'
                            ? 'Someone is using this pass right now. They lose access within 30 seconds and cannot rejoin with the same QR code.'
                            : 'The QR code stops working permanently. Anyone holding a printed copy will no longer be able to redeem it.',
                        confirmLabel: 'Revoke',
                        danger: true,
                      })
                      if (!ok) return
                      await api('/api/admin/revoke', {
                        method: 'POST',
                        body: JSON.stringify({ id: t.id }),
                      })
                      refresh()
                    }}
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))}
            {tokens.length === 0 && (
              <div className="row">
                <div className="row-sub">No passes yet.</div>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="hdr">Add product</div>
          <div className="group">
            <div className="row">
              <div className="row-title" style={{ flex: 1 }}>Name</div>
              <input
                className="field"
                style={{ flex: 2 }}
                placeholder="Chrome Basin Mixer"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="row">
              <div className="row-title" style={{ flex: 1 }}>Category</div>
              <input
                className="field"
                style={{ flex: 2 }}
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              />
            </div>
            <div className="row">
              <div className="row-title" style={{ flex: 1 }}>Icon</div>
              <input
                className="field"
                style={{ flex: 2 }}
                value={form.emoji}
                onChange={(e) => setForm({ ...form, emoji: e.target.value })}
              />
            </div>
            <div className="row">
              <div className="row-main">
                <div className="row-title">Scale</div>
                <div className="row-sub">1 = model already in metres</div>
              </div>
              <input
                className="field"
                style={{ width: 90, textAlign: 'center' }}
                type="number"
                step="0.01"
                value={form.scale}
                onChange={(e) => setForm({ ...form, scale: e.target.value })}
              />
            </div>
            <div className="row" style={{ display: 'block' }}>
              <div className="row-title" style={{ marginBottom: 8 }}>Model file</div>
              <input
                ref={fileRef}
                id="model-file"
                className="file-input"
                type="file"
                accept=".glb,.gltf"
                onChange={(e) => setFileName(e.target.files?.[0]?.name ?? '')}
              />
              <label className="file-label" htmlFor="model-file" data-has-file={!!fileName}>
                <UploadIcon />
                <span className="file-name">{fileName || 'Choose model file'}</span>
                <span className="file-hint">{fileName ? 'Change' : '.glb · 60 MB'}</span>
              </label>
            </div>
          </div>
          <button
            className="btn"
            style={{ marginTop: 12 }}
            disabled={!fileName || !form.name || busy === 'Uploading…'}
            onClick={addProduct}
          >
            {busy === 'Uploading…' ? 'Uploading…' : 'Upload model'}
          </button>
          {busy && (
            <p className="sub" style={{ marginTop: 8, textAlign: 'center' }}>
              {busy}
            </p>
          )}

          <div className="hdr">Catalogue ({products.length})</div>
          <div className="group">
            {products.map((p) => (
              <div className="row" key={p.id}>
                <span style={{ fontSize: 26 }}>{p.emoji}</span>
                <div className="row-main">
                  <div className="row-title">{p.name}</div>
                  <div className="row-sub">
                    {p.category} · ×{p.scale}
                  </div>
                </div>
                <button
                  className="row-action"
                  data-danger="true"
                  aria-label={`Delete ${p.name}`}
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Delete ${p.name}?`,
                      message:
                        'The product leaves the catalogue and its model file is deleted from the server for good. Anyone mid-session loses it immediately.',
                      confirmLabel: 'Delete',
                      danger: true,
                    })
                    if (!ok) return
                    await api('/api/admin/products/delete', {
                      method: 'POST',
                      body: JSON.stringify({ id: p.id }),
                    })
                    refresh()
                  }}
                >
                  <TrashIcon />
                  Delete
                </button>
              </div>
            ))}
            {products.length === 0 && (
              <div className="row">
                <div className="row-sub">
                  No uploaded products yet — the built-in faucet is always available in the app.
                </div>
              </div>
            )}
          </div>
        </>
      )}
      {confirmDialog}
    </div>
  )
}
