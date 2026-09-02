import { Suspense, useEffect, useRef } from 'react'
import { useLoader, useThree } from '@react-three/fiber'
import { Box3, DoubleSide, Group, Mesh, Object3D, Texture, Vector3 } from 'three'
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
    }
    const g = new Group()
    g.add(root)
    holder.current = g
  }
  return <primitive object={holder.current} scale={scale} />
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
