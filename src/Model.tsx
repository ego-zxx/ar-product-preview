import { Suspense, useEffect, useRef } from 'react'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import {
  Box3, CanvasTexture, DoubleSide, Group, Mesh, Object3D, SRGBColorSpace, Texture, Vector3,
} from 'three'
import { patchForGrain, stepGrain } from './grain'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CoffeeCup, Faucet } from './models'
import type { Product } from './products'

/**
 * Offset that puts a model's bounding box on the ground and centred over the
 * origin. Models are authored around arbitrary origins — usually the centre,
 * sometimes a corner — and everything downstream assumes base-at-y=0.
 */
export const groundingOffset = (min: Vector3, max: Vector3) => ({
  x: -(min.x + max.x) / 2 + 0,
  y: -min.y + 0,
  z: -(min.z + max.z) / 2 + 0,
})

/**
 * Tight darkening where the object meets the surface.
 *
 * A shadow map gives the cast shadow but not contact occlusion — the narrow,
 * dark band right under an object where almost no ambient light reaches. Its
 * absence is what makes a correctly-positioned object still read as hovering.
 * This is deliberately small and sharp-falloff, unlike a blob shadow standing
 * in for the whole shadow.
 */
const contactTexture = (() => {
  const size = 128
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(0,0,0,0.55)')
  g.addColorStop(0.35, 'rgba(0,0,0,0.28)')
  g.addColorStop(0.7, 'rgba(0,0,0,0.06)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  return t
})()

function ContactShade({ radius }: { radius: number }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.0008, 0]} renderOrder={2}>
      <planeGeometry args={[radius * 2.6, radius * 2.6]} />
      <meshBasicMaterial map={contactTexture} transparent opacity={0.75} depthWrite={false} />
    </mesh>
  )
}

/**
 * Catches the model's real shadow in the turntable preview. ShadowMaterial is
 * invisible except where a shadow falls, so the plane never shows — only the
 * object's own silhouette, which grounds it far better than a painted blob.
 */
function ShadowCatcher({ size = 0.6 }: { size?: number }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.0012, 0]} receiveShadow>
      <planeGeometry args={[size, size]} />
      <shadowMaterial transparent opacity={0.4} depthWrite={false} side={DoubleSide} />
    </mesh>
  )
}

function GltfModel({ url, scale }: { url: string; scale: number }) {
  const gltf = useLoader(GLTFLoader, url)
  const maxAnisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy())
  const holder = useRef<Object3D | null>(null)
  const footprint = useRef(0.05)
  // advance the grain here so it animates wherever a model is shown, in AR and
  // on the product page alike
  useFrame((state) => stepGrain(state.clock.elapsedTime * 60))
  if (!holder.current) {
    const root = gltf.scene.clone(true)
    root.traverse((o) => {
      const mesh = o as Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      // Anisotropic filtering. Without it a texture seen at a glancing angle —
      // which is every product on a table viewed from standing height — falls
      // to a low mip level and goes soft, sharpening only as you lean in. This
      // is why it looked blurry at a distance and fine up close. three defaults
      // to 1 (off); native viewers enable it, hence the difference.
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        patchForGrain(m)
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const) {
          const tex = (m as unknown as Record<string, Texture | null>)[key]
          if (tex && tex.anisotropy !== maxAnisotropy) {
            tex.anisotropy = maxAnisotropy
            tex.needsUpdate = true
          }
        }
      }
    })
    const box = new Box3().setFromObject(root)
    if (!box.isEmpty()) {
      const o = groundingOffset(box.min, box.max)
      root.position.set(o.x, o.y, o.z)
      // footprint, so the contact shade matches this object rather than a guess
      footprint.current = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.5
    }
    const g = new Group()
    g.add(root)
    holder.current = g
  }
  return (
    <>
      <primitive object={holder.current} scale={scale} />
      <ContactShade radius={footprint.current * scale} />
    </>
  )
}

export function Model({ product }: { product: Product }) {
  const ref = useRef<Group>(null)
  useEffect(() => {
    ref.current?.traverse((o) => {
      if ((o as Mesh).isMesh) o.castShadow = true
    })
  }, [product.id])
  return (
    <group ref={ref}>
      <ShadowCatcher />
      {product.url === 'builtin:faucet' ? (
        <Faucet />
      ) : product.url === 'builtin:cup' ? (
        <CoffeeCup />
      ) : (
        <Suspense fallback={null}>
          <GltfModel url={product.url} scale={product.scale} />
        </Suspense>
      )}
    </group>
  )
}
