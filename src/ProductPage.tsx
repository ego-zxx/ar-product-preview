import { useEffect, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Box3, PMREMGenerator, Vector3, type Group, type PerspectiveCamera } from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { Model } from './Model'
import { supportsQuickLook, usdzUrl, withBanner, QUICK_LOOK_TAP } from './usdz'
import type { Product } from './products'

/** Studio lighting for the non-AR preview — no camera feed to match here. */
function StudioEnv() {
  const { gl, scene } = useThree()
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl)
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = env
    return () => {
      scene.environment = null
      env.dispose()
      pmrem.dispose()
    }
  }, [gl, scene])
  return null
}

/**
 * Turntable with two axes. Everything is driven from refs inside the frame
 * loop — reading a ref during render never updates, which is why dragging
 * previously appeared frozen.
 *
 * Nested groups rather than one Euler rotation: the outer group pitches, the
 * inner yaws, so the model orbits like a turntable instead of tumbling.
 */
function Turntable({ product, ctrl }: { product: Product; ctrl: React.RefObject<Orbit> }) {
  const pitchRef = useRef<Group>(null)
  const yawRef = useRef<Group>(null)
  const modelRef = useRef<Group>(null)
  const framed = useRef(false)
  const camera = useThree((s) => s.camera) as PerspectiveCamera

  // Measure the model and frame the camera to it. Guessing a height cannot work
  // for uploaded models — anything smaller than the guess falls outside the
  // frustum and the preview looks empty.
  //
  // Deliberately not in useFrame: the model arrives via Suspense at an unknown
  // time, and a paused render loop would leave the preview permanently blank.
  useEffect(() => {
    framed.current = false
    let stop = false
    const measure = () => {
      if (stop || !modelRef.current) return
      const box = new Box3().setFromObject(modelRef.current)
      if (box.isEmpty()) {
        setTimeout(measure, 100) // still loading
        return
      }
      const size = box.getSize(new Vector3())
      const centre = box.getCenter(new Vector3())
      // sit the model's centre on the origin so it orbits about itself
      modelRef.current.position.sub(centre)
      const radius = Math.max(size.x, size.y, size.z) * 0.5
      const fit = radius / Math.tan((camera.fov * Math.PI) / 360)
      camera.position.set(0, radius * 0.55, fit * 2.1)
      const c = ctrl.current
      c.dir = camera.position.clone().normalize()
      c.dist = c.targetDist = camera.position.length()
      // half a step in, two and a half out — enough to inspect a logo without
      // being able to lose the object entirely
      c.minDist = c.dist * 0.4
      c.maxDist = c.dist * 2.5
      camera.lookAt(0, 0, 0)
      camera.near = c.minDist / 100
      camera.far = c.maxDist * 20
      camera.updateProjectionMatrix()
      framed.current = true
    }
    measure()
    return () => {
      stop = true
    }
  }, [product.id, camera])

  useFrame((_s, delta) => {
    const c = ctrl.current
    if (!c.dragging) c.targetYaw += delta * 0.45
    const k = 1 - Math.exp(-14 * delta)
    c.yaw += (c.targetYaw - c.yaw) * k
    c.pitch += (c.targetPitch - c.pitch) * k
    if (pitchRef.current) pitchRef.current.rotation.x = c.pitch
    if (yawRef.current) yawRef.current.rotation.y = c.yaw

    if (framed.current) {
      c.dist += (c.targetDist - c.dist) * k
      camera.position.copy(c.dir).multiplyScalar(c.dist)
      camera.lookAt(0, 0, 0)
    }
  })

  return (
    <group ref={pitchRef}>
      <group ref={yawRef}>
        <group ref={modelRef}>
          <Model product={product} grounded={false} />
        </group>
      </group>
    </group>
  )
}

export type Orbit = {
  yaw: number
  pitch: number
  targetYaw: number
  targetPitch: number
  dragging: boolean
  /** camera distance from the model, for pinch and wheel zoom */
  dist: number
  targetDist: number
  minDist: number
  maxDist: number
  /** unit vector the camera sits along; zoom scales it */
  dir: Vector3
}

/** Stop short of straight up/down, where a turntable flips and feels broken. */
const PITCH_MIN = -0.45
const PITCH_MAX = 1.25

/**
 * AR entry point, chosen per platform for the best-looking result.
 *
 * Android uses the in-page WebXR scene: three.js renders
 * KHR_materials_transmission, so glass and liquids read as glass. Scene Viewer
 * ignores that extension and draws a transmissive bottle as flat opaque
 * plastic, which is why it is not used here.
 *
 * iOS has no WebXR at all, so it hands off to AR Quick Look.
 */
function ViewInSpace({
  product, arSupported, onViewInSpace, next, onNext,
}: {
  product: Product
  arSupported: boolean | null
  onViewInSpace: () => void
  next: Product | null
  onNext: () => void
}) {
  const [quickLook, setQuickLook] = useState(false)
  const [state, setState] = useState<'idle' | 'preparing' | 'failed'>('idle')
  const anchor = useRef<HTMLAnchorElement>(null)
  /*
   * The next item's USDZ, converted ahead of time. Quick Look can only be
   * relaunched from inside the tap that dismissed it, and converting a model
   * takes seconds, so awaiting one there would lose the gesture and strand the
   * user on this page — which is the going-back this is meant to avoid.
   */
  const readyNext = useRef<string | null>(null)

  useEffect(() => {
    setQuickLook(supportsQuickLook())
  }, [])

  useEffect(() => {
    readyNext.current = null
  }, [next?.id])

  // Stepping the menu from inside Quick Look: its banner is the only control
  // Apple gives us, and this is the tap arriving back from it.
  useEffect(() => {
    const a = anchor.current
    if (!a) return
    const onMessage = (event: Event) => {
      if ((event as MessageEvent).data !== QUICK_LOOK_TAP) return
      const href = readyNext.current
      if (!href || !next) return
      a.href = withBanner(href, 'Next item', next.name, next.price || next.category)
      a.click()
      onNext()
    }
    a.addEventListener('message', onMessage)
    return () => a.removeEventListener('message', onMessage)
  }, [next, onNext])

  const convertible = !product.url.startsWith('builtin:')

  // Android (and anything else with WebXR): render in-page.
  if (arSupported) {
    return (
      <button className="btn" onClick={onViewInSpace}>
        View in your space
      </button>
    )
  }

  if (quickLook && convertible) {
    const open = async () => {
      setState('preparing')
      try {
        const href = await usdzUrl(product)
        const a = anchor.current
        if (!a) return
        a.href = next
          ? withBanner(href, 'Next item', product.name, product.price || product.category)
          : href
        a.click()
        setState('idle')
        // convert the next one while this one is being looked at, so its tap
        // has a URL waiting rather than a promise
        if (next) usdzUrl(next).then((u) => { readyNext.current = u }).catch(() => {})
      } catch {
        setState('failed')
      }
    }
    return (
      <>
        <button className="btn" disabled={state === 'preparing'} onClick={open}>
          {state === 'preparing' ? 'Preparing…' : 'View in your space'}
        </button>
        {/* Safari only treats rel="ar" as a Quick Look link when it wraps an image */}
        <a ref={anchor} rel="ar" style={{ display: 'none' }} aria-hidden="true">
          <img alt="" />
        </a>
        {state === 'failed' && (
          <p className="sub" style={{ marginTop: 10, textAlign: 'center', color: 'var(--red)' }}>
            Could not prepare this model for AR.
          </p>
        )}
      </>
    )
  }

  return (
    <>
      <button className="btn" disabled>
        View in your space
      </button>
      <p className="sub" style={{ marginTop: 10, textAlign: 'center' }}>
        {arSupported === null
          ? 'Checking…'
          : 'Open on an Android phone or an iPhone to place this in your room.'}
      </p>
    </>
  )
}

export function ProductPage({
  product,
  onBack,
  onViewInSpace,
  arSupported,
  next,
  onNext,
}: {
  product: Product
  onBack: () => void
  onViewInSpace: () => void
  arSupported: boolean | null
  /** the item Quick Look's banner steps to; null when there is only one */
  next: Product | null
  onNext: () => void
}) {
  const ctrl = useRef<Orbit>({
    yaw: 0,
    pitch: 0.25,
    targetYaw: 0,
    targetPitch: 0.25,
    dragging: false,
    dist: 1,
    targetDist: 1,
    minDist: 0.5,
    maxDist: 3,
    dir: new Vector3(0, 0.3, 1).normalize(),
  })
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null)
  /** every finger currently down, so one can rotate and two can pinch */
  const pointers = useRef(new Map<number, { x: number; y: number }>()).current
  const pinch = useRef<{ gap: number; dist: number } | null>(null)

  const gap = () => {
    const [a, b] = [...pointers.values()]
    return Math.hypot(b.x - a.x, b.y - a.y)
  }

  return (
    <div className="page">
      <button className="btn-ghost" style={{ marginTop: 8 }} onClick={onBack}>
        ← Catalogue
      </button>

      <div
        className="turntable"
        onPointerDown={(e) => {
          ;(e.target as Element).setPointerCapture?.(e.pointerId)
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
          const c = ctrl.current
          c.dragging = true
          if (pointers.size === 2) {
            // second finger down: start a pinch and stop rotating, otherwise
            // both fingers drive the rotation and it fights itself
            pinch.current = { gap: gap(), dist: c.targetDist }
            drag.current = null
          } else if (pointers.size === 1) {
            drag.current = { x: e.clientX, y: e.clientY, yaw: c.targetYaw, pitch: c.targetPitch }
          }
        }}
        onPointerMove={(e) => {
          if (!pointers.has(e.pointerId)) return
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
          const c = ctrl.current
          if (pointers.size >= 2 && pinch.current) {
            const ratio = pinch.current.gap / Math.max(1, gap())
            c.targetDist = Math.min(c.maxDist, Math.max(c.minDist, pinch.current.dist * ratio))
            return
          }
          const d = drag.current
          if (!d) return
          c.targetYaw = d.yaw + (e.clientX - d.x) * 0.012
          c.targetPitch = Math.min(
            PITCH_MAX,
            Math.max(PITCH_MIN, d.pitch + (e.clientY - d.y) * 0.012),
          )
        }}
        onPointerUp={(e) => {
          pointers.delete(e.pointerId)
          if (pointers.size < 2) pinch.current = null
          if (pointers.size === 0) {
            drag.current = null
            ctrl.current.dragging = false
          } else {
            // a finger lifted mid-pinch: re-seat the drag on the one remaining
            const [only] = [...pointers.values()]
            const c = ctrl.current
            drag.current = { x: only.x, y: only.y, yaw: c.targetYaw, pitch: c.targetPitch }
          }
        }}
        onPointerCancel={(e) => {
          pointers.delete(e.pointerId)
          pinch.current = null
          if (pointers.size === 0) {
            drag.current = null
            ctrl.current.dragging = false
          }
        }}
        onWheel={(e) => {
          const c = ctrl.current
          c.targetDist = Math.min(
            c.maxDist,
            Math.max(c.minDist, c.targetDist * (1 + Math.sign(e.deltaY) * 0.12)),
          )
        }}
      >
        <Canvas camera={{ fov: 35, position: [0, 0.1, 0.4] }}>
          <StudioEnv />
          <ambientLight intensity={0.4} />
          <directionalLight position={[2, 4, 3]} intensity={1.3} />
          <Turntable product={product} ctrl={ctrl} />
        </Canvas>
        <span className="turntable-hint">Drag to turn · pinch to zoom</span>
      </div>

      <h1 className="title" style={{ marginBottom: 0 }}>
        {product.name}
      </h1>
      <div className="hdr" style={{ margin: '0 4px 18px' }}>{product.category}</div>

      {product.price && <div className="price">{product.price}</div>}

      {product.description && (
        <p className="sub" style={{ marginTop: 14 }}>
          {product.description}
        </p>
      )}

      <div style={{ marginTop: 26 }}>
        <ViewInSpace
          product={product}
          arSupported={arSupported}
          onViewInSpace={onViewInSpace}
          next={next}
          onNext={onNext}
        />
      </div>

      {(product.dimensions || product.specs?.length) && (
        <>
          <div className="hdr">Specifications</div>
          <div className="group">
            {product.dimensions && (
              <div className="row">
                <div className="row-main">
                  <div className="row-title">Dimensions</div>
                </div>
                <span className="row-val">{product.dimensions}</span>
              </div>
            )}
            {product.specs?.map((s) => (
              <div className="row" key={s.label}>
                <div className="row-main">
                  <div className="row-title">{s.label}</div>
                </div>
                <span className="row-val">{s.value}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
