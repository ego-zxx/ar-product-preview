import { Suspense, useEffect, useRef } from 'react'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import {
  Box3, CanvasTexture, DoubleSide, Group, Mesh, Object3D, ShadowMaterial, SRGBColorSpace, Texture, Vector2, Vector3,
} from 'three'
import { EDGE_FEATHER_AR, grainUniforms, patchForGrain, stepGrain, VIGNETTE_AR } from './grain'
import { improveMaterial, shadowTint } from './materials'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
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

/*
 * Contact darkening: the ambient occlusion right where an object meets a
 * surface, which no shadow map resolves because it lives inside a texel.
 *
 * It used to be doing a second job it is bad at. At 2.6x the footprint and 75%
 * it read as a shadow — a fixed, non-directional one, sitting under a real
 * shadow that moves with the room's light, which is physically incoherent and
 * darkened the contact twice. Since the shadow frustum was fitted to the object
 * the real shadow resolves at about a fifth of a millimetre per texel and can
 * carry that on its own, so this is back to the narrow band it is actually for.
 */
function ContactShade({ radius }: { radius: number }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.0008, 0]} renderOrder={2}>
      <planeGeometry args={[radius * 1.5, radius * 1.5]} />
      <meshBasicMaterial map={contactTexture} transparent opacity={0.3} depthWrite={false} />
    </mesh>
  )
}

/**
 * Catches the model's real shadow in the turntable preview. ShadowMaterial is
 * invisible except where a shadow falls, so the plane never shows — only the
 * object's own silhouette, which grounds it far better than a painted blob.
 */
function ShadowCatcher({ size = 0.6 }: { size?: number }) {
  const material = useRef<ShadowMaterial>(null)
  useFrame(() => material.current?.color.copy(shadowTint))
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.0012, 0]} receiveShadow>
      <planeGeometry args={[size, size]} />
      <shadowMaterial ref={material} transparent opacity={0.55} depthWrite={false} side={DoubleSide} />
    </mesh>
  )
}

/**
 * World-space bounding sphere of the model on show, so the occluders can tell
 * whether a detected plane passes through it. Radius 0 means nothing placed.
 */
export const objectBounds = { center: new Vector3(), radius: 0 }

function GltfModel({ url, scale, grounded }: { url: string; scale: number; grounded: boolean }) {
  const gltf = useLoader(GLTFLoader, url)
  const maxAnisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy())
  const holder = useRef<Object3D | null>(null)
  const footprint = useRef(0.05)
  // local-space sphere, measured once; tracked into world space each frame
  const sphere = useRef({ center: new Vector3(), radius: 0 })
  // advance the grain here so it animates wherever a model is shown, in AR and
  // on the product page alike. In XR three resizes the drawing buffer to the
  // XR framebuffer, so this is the size the vignette must be centred on.
  const bufferSize = useRef(new Vector2())
  useFrame((state) => {
    const size = state.gl.getDrawingBufferSize(bufferSize.current)
    stepGrain(state.clock.elapsedTime * 60, size.x, size.y)
    if (grounded && holder.current) {
      const m = holder.current.matrixWorld
      objectBounds.center.copy(sphere.current.center).applyMatrix4(m)
      // largest axis scale, so a non-uniform scale still covers the model
      objectBounds.radius =
        sphere.current.radius *
        Math.max(
          Math.hypot(m.elements[0], m.elements[1], m.elements[2]),
          Math.hypot(m.elements[4], m.elements[5], m.elements[6]),
          Math.hypot(m.elements[8], m.elements[9], m.elements[10]),
        )
    }
    grainUniforms.uVignette.value = grounded ? VIGNETTE_AR : 0
    grainUniforms.uPlate.value = grounded ? 1 : 0
    grainUniforms.uEdgeFeather.value = grounded ? EDGE_FEATHER_AR : 0
  })
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
        improveMaterial(m)
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
      box.getCenter(sphere.current.center).add(o)
      sphere.current.radius = box.min.distanceTo(box.max) * 0.5
    }
    const g = new Group()
    g.add(root)
    holder.current = g
  }
  return (
    <>
      <primitive object={holder.current} scale={scale} />
      {grounded && <ContactShade radius={footprint.current * scale} />}
    </>
  )
}

/**
 * `grounded` marks that the model is standing on a real surface, i.e. in AR.
 * The contact darkening and shadow catcher are cues about meeting a floor, so
 * in the product page's studio void they have nothing to describe — the
 * contact disc in particular is simply a dark circle that becomes visible as
 * the model turns.
 */
export function Model({ product, grounded = true }: { product: Product; grounded?: boolean }) {
  const ref = useRef<Group>(null)
  useEffect(() => {
    ref.current?.traverse((o) => {
      if ((o as Mesh).isMesh) o.castShadow = true
    })
    return () => {
      objectBounds.radius = 0
    }
  }, [product.id])
  return (
    <group ref={ref}>
      {grounded && <ShadowCatcher />}
      <Suspense fallback={null}>
        <GltfModel url={product.url} scale={product.scale} grounded={grounded} />
      </Suspense>
    </group>
  )
}
