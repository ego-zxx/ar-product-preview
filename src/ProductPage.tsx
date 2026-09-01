import { useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { PMREMGenerator, type Group } from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { useEffect } from 'react'
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

/** Idles on a slow spin; a drag takes over and the spin resumes on release. */
function Turntable({ product, spinRef }: { product: Product; spinRef: React.RefObject<number> }) {
  const ref = useRef<Group>(null)
  useFrame((_s, delta) => {
    if (!ref.current) return
    spinRef.current += delta * 0.45
    ref.current.rotation.y = spinRef.current
  })
  return (
    <group ref={ref}>
      <Model product={product} />
    </group>
  )
}

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
  const spin = useRef(0)
  const drag = useRef<{ x: number; from: number } | null>(null)
  const [spinning, setSpinning] = useState(true)

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
          drag.current = { x: e.clientX, from: spin.current }
          setSpinning(false)
          ;(e.target as Element).setPointerCapture?.(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          spin.current = drag.current.from + (e.clientX - drag.current.x) * 0.01
        }}
        onPointerUp={() => {
          drag.current = null
          setSpinning(true)
        }}
      >
        <Canvas camera={{ position: [0, height * 0.9, height * 3.2], fov: 35 }}>
          <StudioEnv />
          <ambientLight intensity={0.4} />
          <directionalLight position={[2, 4, 3]} intensity={1.3} />
          <group position={[0, -height / 2, 0]}>
            {spinning ? (
              <Turntable product={product} spinRef={spin} />
            ) : (
              <group rotation-y={spin.current}>
                <Model product={product} />
              </group>
            )}
          </group>
        </Canvas>
        <span className="turntable-hint">Drag to turn</span>
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
