import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Matrix4, NeutralToneMapping } from 'three'
import { XR, XRDomOverlay, createXRStore, useXR } from '@react-three/xr'
import {
  DepthOcclusion, DiagnosticsProbe, Env, EstimatedLighting, KeyLight, PlaneOcclusion, Placement,
  type Diag,
  newGesture, type Draft, type Gesture, type Placed,
} from './ARScene'
import { Halation } from './halation'
import { CameraExposure } from './exposure'
import { useAccess } from './access'
import { fetchProducts, type Product } from './products'
import { ProductPage } from './ProductPage'

const overlayRoot = document.getElementById('ar-overlay')!
const store = createXRStore({
  domOverlay: overlayRoot,
  // Full render resolution. This was 0.8 when the scene could hold twenty
  // objects; with one product there is headroom, and rendering at 80% then
  // upscaling softens everything uniformly. Drop it again if a weak device
  // drops frames — sharpness is worth more than headroom for a product shot,
  // but not worth a stutter.
  frameBufferScaling: 1,
  // Spelled out so features can be added or dropped explicitly. Everything past
  // local-floor is optional: a runtime that declines one (mid-range phones
  // decline depth-sensing) still gets a working session.
  customSessionInit: {
    requiredFeatures: ['local-floor'],
    optionalFeatures: [
      'hit-test',
      'anchors',
      'plane-detection',
      'light-estimation',
      // the camera image itself, so exposure can be matched to the feed rather
      // than guessed from the light estimate alone
      'camera-access',
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
  const [hasSurface, setHasSurface] = useState(false)
  // real room lighting has taken over from the static rig
  const [litByRoom, setLitByRoom] = useState(false)
  // ?debug=1 shows what the renderer is actually doing, for reporting back
  const debug = useMemo(() => new URLSearchParams(location.search).has('debug'), [])
  const [diag, setDiag] = useState<Diag | null>(null)
  const [uiHidden, setUiHidden] = useState(false)
  const [route, setRoute] = useState(() => location.hash)
  const uiHiddenRef = useRef(false)
  uiHiddenRef.current = uiHidden
  const commitRef = useRef<(() => void) | null>(null)
  const resumeRef = useRef<((id: number) => boolean) | null>(null)
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
      if (!draft && selected && objects.length === 0) setDraft({ product: selected })
    },
    [draft, selected, objects.length],
  )

  /*
   * Step to the next item without leaving AR, so a menu can be browsed in
   * place. Anything already placed keeps its pose and swaps model, which is
   * the point: the comparison people actually want is the same spot on the
   * same table, not the same dish in two different rooms. Wraps, so one arrow
   * reaches every item.
   */
  const nextProduct = useCallback(() => {
    if (products.length < 2) return
    const at = products.findIndex((p) => p.id === productId)
    const next = products[(at + 1) % products.length]
    setProductId(next.id)
    setDraft((d) => (d ? { product: next } : d))
    setObjects((placed) => placed.map((o) => ({ ...o, product: next })))
  }, [products, productId])

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
  /*
   * The item after this one, for Quick Look's banner. iOS AR is a system screen
   * with no room for our overlay, so where Android gets an arrow, iOS gets the
   * one banner Apple allows — and it needs to know where "next" goes.
   */
  const routedNext = useMemo(() => {
    if (!routed || products.length < 2) return null
    const at = products.findIndex((p) => p.id === routed.id)
    return products[(at + 1) % products.length]
  }, [routed, products])

  return (
    <>
      {routed ? (
        <ProductPage
          product={routed}
          arSupported={supported}
          next={routedNext}
          onNext={() => {
            if (routedNext) location.hash = `#/product/${routedNext.id}`
          }}
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
      <Canvas
        shadows="percentage"
        // Neutral tone mapping rather than ACES: ACES crushes contrast and
        // desaturates, which makes a virtual object read as pasted onto the
        // camera feed. Neutral (Khronos PBR) preserves colour, so the product
        // sits in the frame instead of on it. toneMappingExposure is the knob
        // if objects look consistently darker or brighter than the room.
        gl={{
          toneMapping: NeutralToneMapping,
          toneMappingExposure: 1,
          antialias: true,
        }}
        style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }}
      >
        <XR store={store}>
          <Env />
          <Halation />
          <CameraExposure />
          <PlaneOcclusion />
          <DepthOcclusion />
          <EstimatedLighting onActive={setLitByRoom} />
          {debug && <DiagnosticsProbe lit={litByRoom} onSample={setDiag} />}
          {/* static rig only until the room's own lighting is available */}
          {!litByRoom && (
            <>
              <ambientLight intensity={0.4} />
              <KeyLight />
            </>
          )}
          <Placement
            objects={objects}
            draft={draft}
            selectedId={selectedId}
            commitRef={commitRef}
            onCommit={onCommit}
            gestureRef={gestureRef}
            resumeRef={resumeRef}
            uiHidden={uiHidden}
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

            {products.length > 1 && (
              <button
                className="ar-icon ar-next"
                aria-label="Next item"
                onPointerDown={muteSelect}
                onClick={nextProduct}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9.3 4.7a1 1 0 0 0 0 1.4l5.9 5.9-5.9 5.9a1 1 0 1 0 1.4 1.4l6.6-6.6a1 1 0 0 0 0-1.4L10.7 4.7a1 1 0 0 0-1.4 0Z" />
                </svg>
              </button>
            )}

            <div className="ar-top">
              <button
                className="ar-icon"
                aria-label="Exit AR"
                onPointerDown={muteSelect}
                onClick={() => store.getState().session?.end()}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4l4.9 4.9-4.9 4.9a1 1 0 1 0 1.4 1.4l4.9-4.9 4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z" />
                </svg>
              </button>

              {objects.length > 0 && !draft && selectedId == null && (
                <button
                  className="ar-icon"
                  aria-label="Hide controls"
                  onPointerDown={muteSelect}
                  onClick={() => setUiHidden(true)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7Zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
                  </svg>
                </button>
              )}
            </div>

            {/* One status line, not three competing pills. */}
            {debug && diag && (
              <div className="ar-debug">
                {`fps ${diag.fps}
lighting ${diag.lit ? 'ROOM ✓' : 'fixed rig ✗'}
shadow ${diag.shadowFrom}
occlusion ${diag.occlusion ? 'on' : 'off'}
framebuffer ${diag.fb}
anisotropy ${diag.anisotropy}
room light ${diag.ambient} · exposure ${diag.exposure}
halation ${diag.halation ? 'on' : 'off'}
feed ${diag.feed}`}
              </div>
            )}
            <div className="ar-status">
              <span className="ar-status-pill" data-warn={!hasSurface && !draft}>
                {!hasSurface && !draft
                  ? 'Move the phone slowly to find a surface'
                  : draft
                    ? 'Drag to move · two fingers to turn'
                    : selectedId != null
                      ? 'Selected'
                      : objects.length === 0
                        ? `Tap a surface to place ${selected?.name ?? ''}`
                        : // once something is placed the dish's name is the
                          // useful thing to show, not the tap hint it replaces:
                          // stepping through a menu is unreadable without it
                          (selected?.name ?? 'Tap it to move or remove')}
              </span>
            </div>

            {error && <div className="err">{error}</div>}

            <div className="ar-bottom">
              {draft && (
                <div className="ar-actions">
                  <button className="pill" onPointerDown={muteSelect} onClick={() => setDraft(null)}>
                    Cancel
                  </button>
                  <button className="pill" data-primary="true" onPointerDown={muteSelect} onClick={() => commitRef.current?.()}>
                    Lock in place
                  </button>
                </div>
              )}
              {selectedId != null && (
                <div className="ar-actions">
                  <button
                    className="pill"
                    data-primary="true"
                    onPointerDown={muteSelect}
                    onClick={() => {
                      // Unlock: hand the placed pose back to the draft so it can
                      // be dragged and turned again, then locked afresh.
                      const target = objects.find((o) => o.id === selectedId)
                      if (target && resumeRef.current?.(selectedId)) {
                        deleteObject(selectedId)
                        setDraft({ product: target.product })
                      }
                      setSelectedId(null)
                    }}
                  >
                    Move
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
