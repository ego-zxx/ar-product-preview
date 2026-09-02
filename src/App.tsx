import { useEffect, useMemo, useState } from 'react'
import { useAccess } from './access'
import { fetchProducts, type Product } from './products'
import { ProductPage } from './ProductPage'

function timeLeft(ms: number) {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000))
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`
}

export function App() {
  const [products, setProducts] = useState<Product[]>([])
  const [category, setCategory] = useState('All')
  const [route, setRoute] = useState(() => location.hash)
  const [error, setError] = useState<string | null>(null)
  const access = useAccess()

  useEffect(() => {
    fetchProducts().then(setProducts)
    const onHash = () => setRoute(location.hash)
    addEventListener('hashchange', onHash)
    // Surface anything that would otherwise fail silently.
    const onErr = (e: ErrorEvent) => setError(e.message)
    const onRej = (e: PromiseRejectionEvent) => setError(String(e.reason))
    addEventListener('error', onErr)
    addEventListener('unhandledrejection', onRej)
    return () => {
      removeEventListener('hashchange', onHash)
      removeEventListener('error', onErr)
      removeEventListener('unhandledrejection', onRej)
    }
  }, [])

  const categories = useMemo(
    () => ['All', ...new Set(products.map((p) => p.category))],
    [products],
  )
  const shown = useMemo(
    () => (category === 'All' ? products : products.filter((p) => p.category === category)),
    [products, category],
  )

  const routed = route.startsWith('#/product/')
    ? products.find((p) => p.id === route.slice('#/product/'.length))
    : null

  if (routed) {
    return (
      <ProductPage
        product={routed}
        onBack={() => {
          location.hash = ''
        }}
      />
    )
  }

  return (
    <div className="page">
      <h1 className="title">Preview</h1>

      {access.state !== 'valid' ? (
        <div className="group">
          <div className="row">
            <div className="row-main">
              <div className="row-title">
                {access.state === 'checking' ? 'Checking access…' : 'No active pass'}
              </div>
              <div className="row-sub">
                {access.state === 'denied'
                  ? access.reason
                  : 'Scan an access QR code to start your session.'}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="group">
            <div className="row">
              <div className="row-main">
                <div className="row-title">Session active</div>
                <div className="row-sub">
                  Until {new Date(access.expiresAt).toLocaleString()}
                </div>
              </div>
              <span className="badge" style={{ color: 'var(--green)' }}>
                {timeLeft(access.expiresAt)}
              </span>
            </div>
          </div>

          <div className="hdr">Catalogue</div>
          {categories.length > 2 && (
            <div className="seg">
              {categories.map((c) => (
                <button key={c} data-on={c === category} onClick={() => setCategory(c)}>
                  {c}
                </button>
              ))}
            </div>
          )}
          <div className="grid">
            {shown.map((p) => (
              <button
                key={p.id}
                className="card"
                onClick={() => {
                  location.hash = `#/product/${p.id}`
                }}
              >
                <div className="card-thumb">{p.emoji}</div>
                <div className="card-name">{p.name}</div>
                <div className="card-meta">{p.category}</div>
              </button>
            ))}
          </div>

          {shown.length === 0 && (
            <p className="sub" style={{ marginTop: 18 }}>
              No products yet. Add some in the admin panel.
            </p>
          )}
        </>
      )}

      {error && (
        <>
          <div className="hdr">Diagnostics</div>
          <div className="group">
            <div className="row">
              <div className="row-main">
                <div className="row-sub" style={{ color: 'var(--red)' }}>{error}</div>
              </div>
              <button className="btn-ghost" onClick={() => setError(null)}>
                Clear
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
