import { useEffect, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { PMREMGenerator, type Group } from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { Model } from './ARScene'
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
  const height = product.url === 'builtin:cup' ? 0.095 : 0.2

  useFrame((_s, delta) => {
    const c = ctrl.current
    if (!c.dragging) c.targetYaw += delta * 0.45
    // ease toward the target, frame-rate independent
    const k = 1 - Math.exp(-14 * delta)
    c.yaw += (c.targetYaw - c.yaw) * k
    c.pitch += (c.targetPitch - c.pitch) * k
    if (pitchRef.current) pitchRef.current.rotation.x = c.pitch
    if (yawRef.current) yawRef.current.rotation.y = c.yaw
  })

  return (
    <group ref={pitchRef}>
      <group ref={yawRef}>
        {/* centre the model on the origin so it orbits about its middle */}
        <group position={[0, -height / 2, 0]}>
          <Model product={product} />
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
}

/** Stop short of straight up/down, where a turntable flips and feels broken. */
const PITCH_MIN = -0.45
const PITCH_MAX = 1.25

export function ProductPage({
  product,
  onBack,
  onViewInSpace,
  arSupported,
}: {
  product: Product
  onBack: () => void
  onViewInSpace: () => void
  arSupported: boolean | null
}) {
  const ctrl = useRef<Orbit>({
    yaw: 0,
    pitch: 0.25,
    targetYaw: 0,
    targetPitch: 0.25,
    dragging: false,
  })
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null)

  // The model is authored in metres, so frame the camera to its real height.
  const height = product.url === 'builtin:cup' ? 0.095 : 0.2

  return (
    <div className="page">
      <button className="btn-ghost" style={{ marginTop: 8 }} onClick={onBack}>
        ← Catalogue
      </button>

      <div
        className="turntable"
        onPointerDown={(e) => {
          const c = ctrl.current
          drag.current = { x: e.clientX, y: e.clientY, yaw: c.targetYaw, pitch: c.targetPitch }
          c.dragging = true
          ;(e.target as Element).setPointerCapture?.(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const c = ctrl.current
          c.targetYaw = d.yaw + (e.clientX - d.x) * 0.012
          c.targetPitch = Math.min(
            PITCH_MAX,
            Math.max(PITCH_MIN, d.pitch + (e.clientY - d.y) * 0.012),
          )
        }}
        onPointerUp={() => {
          drag.current = null
          ctrl.current.dragging = false
        }}
        onPointerCancel={() => {
          drag.current = null
          ctrl.current.dragging = false
        }}
      >
        <Canvas camera={{ position: [0, height * 0.9, height * 3.2], fov: 35 }}>
          <StudioEnv />
          <ambientLight intensity={0.4} />
          <directionalLight position={[2, 4, 3]} intensity={1.3} />
          <Turntable product={product} ctrl={ctrl} />
        </Canvas>
        <span className="turntable-hint">Drag to turn · up and down to tilt</span>
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

      <button className="btn" style={{ marginTop: 26 }} disabled={!arSupported} onClick={onViewInSpace}>
        View in your space
      </button>
      {!arSupported && (
        <p className="sub" style={{ marginTop: 10, textAlign: 'center' }}>
          {arSupported === null ? 'Checking…' : 'Open in Chrome on Android to place this in your room.'}
        </p>
      )}

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
