import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Matrix4 } from 'three'
import { XR, XRDomOverlay, createXRStore, useXR } from '@react-three/xr'
import {
  DepthOcclusion, Env, MAX_OBJECTS, PlaneOcclusion, Placement, RealLighting,
  newGesture, type Draft, type Gesture, type Placed,
} from './ARScene'
import { useAccess } from './access'
import { fetchProducts, type Product } from './products'
import { ProductPage } from './ProductPage'

const overlayRoot = document.getElementById('ar-overlay')!
const store = createXRStore({
  domOverlay: overlayRoot,
  // ponytail: 0.8 render scale — a mid-range phone can't drive PBR + env map at
  // native 2.8x DPR. Raise toward 1 if a target device has headroom.
  frameBufferScaling: 0.8,
  // The library has no light-estimation option, so the whole init is spelled
  // out here. Everything past local-floor is optional: a runtime that declines
  // one (this phone declines depth-sensing) still gets a working session.
  customSessionInit: {
    requiredFeatures: ['local-floor'],
    optionalFeatures: [
      'hit-test',
      'anchors',
      'plane-detection',
      'light-estimation',
      'depth-sensing',
      'dom-overlay',
    ],
    domOverlay: { root: overlayRoot },
    depthSensing: {
      usagePreference: ['gpu-optimized', 'cpu-optimized'],
      dataFormatPreference: ['luminance-alpha', 'float32'],
    },
  } as XRSessionInit,
})

// dev-only handle for remote debugging over the DevTools protocol
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__xr = store

let nextId = 1

/** DOM-overlay chrome must only mount during an active XR session. */
function InSession({ children }: { children: React.ReactNode }) {
  const session = useXR((s) => s.session)
  return session ? <>{children}</> : null
}

function timeLeft(ms: number) {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000))
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`
}

export function App() {
  const [supported, setSupported] = useState<boolean | null>(null)
  const [objects, setObjects] = useState<Placed[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [hasSurface, setHasSurface] = useState(false)
  const [uiHidden, setUiHidden] = useState(false)
  const [route, setRoute] = useState(() => location.hash)
  const uiHiddenRef = useRef(false)
  uiHiddenRef.current = uiHidden
  const commitRef = useRef<(() => void) | null>(null)
  const gestureRef = useRef<Gesture>(newGesture())
  const pointers = useRef(new Map<number, { x: number; y: number }>()).current
  const [products, setProducts] = useState<Product[]>([])
  const [productId, setProductId] = useState<string | null>(null)
  const [category, setCategory] = useState('All')
  const [error, setError] = useState<string | null>(null)
  const access = useAccess()

  useEffect(() => {
    navigator.xr?.isSessionSupported('immersive-ar').then(setSupported) ?? setSupported(false)
    fetchProducts().then((p) => {
      setProducts(p)
      setProductId((s) => s ?? p[0]?.id ?? null)
    })
    // Surface anything that would otherwise silently kill the AR frame loop.
    const onHash = () => setRoute(location.hash)
    addEventListener('hashchange', onHash)
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

  const selected = useMemo(
    () => products.find((p) => p.id === productId) ?? null,
    [products, productId],
  )
  const categories = useMemo(
    () => ['All', ...new Set(products.map((p) => p.category))],
    [products],
  )
  const shown = useMemo(
    () => (category === 'All' ? products : products.filter((p) => p.category === category)),
    [products, category],
  )

  // tap: select the locked object under the reticle, else start a draft
  const onTap = useCallback(
    (nearestId: number | null) => {
      if (uiHiddenRef.current) return // clean view: look, don't edit
      if (nearestId != null) {
        setSelectedId(nearestId)
        setDraft(null)
        return
      }
      setSelectedId(null)
      // Placement stored the pose; App only tracks which product is in flight.
      if (!draft && selected && objects.length < MAX_OBJECTS) setDraft({ product: selected })
    },
    [draft, selected, objects.length],
  )

  // Read the draft through a ref: React may re-run or discard a state updater,
  // so committing must never happen *inside* one.
  const draftLive = useRef<Draft | null>(null)
  draftLive.current = draft

  const onCommit = useCallback(
    (p: { anchor?: XRAnchor; matrix?: Matrix4; yaw: number }) => {
      const d = draftLive.current
      if (!d) return
      const placed: Placed = { id: nextId++, product: d.product, ...p }
      setObjects((o) => [...o, placed])
      setDraft(null)
    },
    [],
  )

  // An anchor must outlive the render that still references it: reading
  // anchorSpace after delete() throws and takes the whole scene down. Queue
  // them and release once React has committed the removal.
  const retired = useRef<XRAnchor[]>([])

  const deleteObject = (id: number) => {
    const target = objects.find((x) => x.id === id)
    if (target?.anchor) retired.current.push(target.anchor)
    setObjects((o) => o.filter((x) => x.id !== id))
  }

  const clear = () => {
    objects.forEach((p) => p.anchor && retired.current.push(p.anchor))
    setObjects([])
  }

  // Anchors belong to the XRSession that made them. Carrying objects across a
  // session boundary makes every getPose() throw "XRSpace and XRFrame sessions
  // do not match" on every frame, which kills the frame loop — the second and
  // every later AR session would be dead. A new session is a new world: reset.
  useEffect(
    () =>
      store.subscribe((s, prev) => {
        if (prev.session && !s.session) {
          retired.current = [] // stale anchors; delete() would throw too
          setObjects([])
          setDraft(null)
          setSelectedId(null)
          setConfirmClear(false)
          setHasSurface(false)
          setUiHidden(false)
        }
      }),
    [],
  )

  useEffect(() => {
    if (!retired.current.length) return
    for (const a of retired.current) {
      try {
        a.delete()
      } catch {
        // already gone (tracking loss can retire an anchor for us)
      }
    }
    retired.current = []
  }, [objects])

  // One finger drags the object across the surface, two fingers rotate it.
  /**
   * One finger drags, two fingers twist. The twist is read from the ANGLE
   * between the two fingers — deriving it from one finger's x, as this did
   * before, means whichever finger moved last wins and rotation is erratic.
   */
  const syncGesture = () => {
    const g = gestureRef.current
    const pts = [...pointers.values()]
    if (pts.length >= 2) {
      const [a, b] = pts
      g.twist = Math.atan2(b.y - a.y, b.x - a.x)
      g.mode = 'rotate' // Placement accumulates the twist delta each frame
    } else if (pts.length === 1) {
      g.x = pts[0].x
      g.y = pts[0].y
      g.mode = 'move'
    } else {
      g.mode = 'none'
    }
  }

  const gestureHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      syncGesture()
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!pointers.has(e.pointerId)) return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      syncGesture()
    },
    onPointerUp: (e: React.PointerEvent) => {
      pointers.delete(e.pointerId)
      syncGesture()
    },
    onPointerCancel: (e: React.PointerEvent) => {
      pointers.delete(e.pointerId)
      syncGesture()
    },
  }

  /** Overlay buttons emit an XR select too; mute it briefly so taps don't reselect. */
  const muteSelect = () => {
    gestureRef.current.suppressSelectUntil = performance.now() + 600
  }

  const routed = route.startsWith('#/product/')
    ? products.find((p) => p.id === route.slice('#/product/'.length))
    : null

  return (
    <>
      {routed ? (
        <ProductPage
          product={routed}
          arSupported={supported}
          onBack={() => {
            location.hash = ''
          }}
          onViewInSpace={() => {
            setProductId(routed.id)
            location.hash = ''
            store.enterAR()
          }}
        />
      ) : (
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
                  data-on={p.id === productId}
                  onClick={() => {
                    setProductId(p.id)
                    location.hash = `#/product/${p.id}`
                  }}
                >
                  <div className="card-thumb">{p.emoji}</div>
                  <div className="card-name">{p.name}</div>
                  <div className="card-meta">{p.category}</div>
                </button>
              ))}
            </div>

            <div style={{ marginTop: 22 }}>
              {supported ? (
                <button className="btn" disabled={!selected} onClick={() => store.enterAR()}>
                  Place in your room
                </button>
              ) : (
                <div className="group">
                  <div className="row">
                    <div className="row-main">
                      <div className="row-title">AR not available here</div>
                      <div className="row-sub">
                        {supported === null
                          ? 'Checking…'
                          : 'Open in Chrome on Android for full AR, or try the iPhone marker demo.'}
                      </div>
                    </div>
                  </div>
                  <a className="row" href="/ios-spike.html" style={{ color: 'var(--blue)' }}>
                    iPhone marker demo
                  </a>
                </div>
              )}
            </div>
          </>
        )}

        {error && (
          <>
            <div className="hdr">Diagnostics</div>
            <div className="group">
              <div className="row">
                <div className="row-main">
                  <div className="row-sub" style={{ fontFamily: 'ui-monospace, monospace' }}>
                    {error}
                  </div>
                </div>
                <button className="btn-ghost" onClick={() => setError(null)}>
                  Clear
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      )}

      {/* Sits behind the UI and must never take pointer events: all interaction
          is DOM (landing/overlay) or XR select. Without this the full-screen
          canvas swallows every tap on the page. */}
      <Canvas style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
        <XR store={store}>
          <Env />
          <PlaneOcclusion />
          <DepthOcclusion />
          <RealLighting />
          <Placement
            objects={objects}
            draft={draft}
            selectedId={selectedId}
            commitRef={commitRef}
            onCommit={onCommit}
            gestureRef={gestureRef}
            onTap={onTap}
            onSurface={setHasSurface}
            onError={setError}
          />
          <InSession>
          <XRDomOverlay>
            {uiHidden ? (
              <button
                className="ar-restore"
                aria-label="Show controls"
                onPointerDown={muteSelect}
                onClick={() => setUiHidden(false)}
              >
                <svg viewBox="0 0 256 128" aria-hidden="true">
                  <path d="M128 40 36 96a8 8 0 0 1-9-13l96-58a8 8 0 0 1 9 0l96 58a8 8 0 1 1-9 13Z" />
                </svg>
              </button>
            ) : (
            <>
            {/* full-screen rotate surface, only while positioning a draft.
                Being a DOM element it also stops taps reaching the XR select. */}
            {draft && <div className="ar-rotate" {...gestureHandlers} />}

            <div className="ar-top">
              <button className="pill" onPointerDown={muteSelect} onClick={() => store.getState().session?.end()}>
                Done
              </button>
              {objects.length > 0 && !draft && selectedId == null && (
                <button
                  className="pill"
                  style={{ marginLeft: 'auto' }}
                  onPointerDown={muteSelect}
                  onClick={() => setUiHidden(true)}
                >
                  Clean view
                </button>
              )}
              <span className="pill" data-quiet="true">
                {draft
                  ? 'Drag to move · two fingers to rotate'
                  : selectedId != null
                    ? 'Selected'
                    : objects.length === 0
                      ? `Tap to place ${selected?.name ?? ''}`
                      : `${objects.length} placed`}
              </span>
              {!hasSurface && !draft && (
                <span className="pill" data-quiet="true" style={{ color: 'var(--orange)' }}>
                  Scanning — move the phone slowly
                </span>
              )}
            </div>

            {error && <div className="err">{error}</div>}

            <div className="ar-bottom">
              {draft && !confirmClear && (
                <div className="ar-actions">
                  <button className="pill" onPointerDown={muteSelect} onClick={() => setDraft(null)}>
                    Cancel
                  </button>
                  <button className="pill" data-primary="true" onPointerDown={muteSelect} onClick={() => commitRef.current?.()}>
                    Lock in place
                  </button>
                </div>
              )}
              {confirmClear && (
                <div className="ar-actions" role="alertdialog" aria-label="Remove everything?">
                  <span className="pill" data-quiet="true">
                    Remove all {objects.length}?
                  </span>
                  <button className="pill" onPointerDown={muteSelect} onClick={() => setConfirmClear(false)}>
                    Keep
                  </button>
                  <button
                    className="pill"
                    data-danger="true"
                    onPointerDown={muteSelect}
                    onClick={() => {
                      clear()
                      setSelectedId(null)
                      setConfirmClear(false)
                    }}
                  >
                    Remove all
                  </button>
                </div>
              )}
              {selectedId != null && !confirmClear && (
                <div className="ar-actions">
                  <button className="pill" onPointerDown={muteSelect} onClick={() => setSelectedId(null)}>
                    Deselect
                  </button>
                  <button
                    className="pill"
                    data-danger="true"
                    onPointerDown={muteSelect}
                    onClick={() => {
                      deleteObject(selectedId)
                      setSelectedId(null)
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
              <div className="tray">
                <div className="tray-scroll">
                  {products.map((p) => (
                    <button
                      key={p.id}
                      className="tray-item"
                      data-on={p.id === productId}
                      onPointerDown={muteSelect}
                      onClick={() => {
                        setProductId(p.id)
                        setDraft((d) => (d ? { ...d, product: p } : d))
                      }}
                    >
                      <span className="tray-emoji">{p.emoji}</span>
                      {p.name}
                    </button>
                  ))}
                  {objects.length > 0 && (
                    <button
                      className="tray-item"
                      style={{ color: 'var(--red)' }}
                      aria-label={`Clear all ${objects.length} placed items`}
                      onPointerDown={muteSelect}
                      onClick={() => setConfirmClear(true)}
                    >
                      <svg className="tray-emoji" viewBox="0 0 256 256" aria-hidden="true"
                        style={{ width: 25, height: 25, fill: 'currentColor', margin: '0 auto 3px' }}>
                        <path d="M216 48h-40v-8a24 24 0 0 0-24-24h-48a24 24 0 0 0-24 24v8H40a8 8 0 0 0 0 16h8v144a16 16 0 0 0 16 16h128a16 16 0 0 0 16-16V64h8a8 8 0 0 0 0-16ZM96 40a8 8 0 0 1 8-8h48a8 8 0 0 1 8 8v8H96Zm96 168H64V64h128Zm-80-104v64a8 8 0 0 1-16 0v-64a8 8 0 0 1 16 0Zm48 0v64a8 8 0 0 1-16 0v-64a8 8 0 0 1 16 0Z" />
                      </svg>
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>
            </>
            )}
          </XRDomOverlay>
          </InSession>
        </XR>
      </Canvas>
    </>
  )
}
