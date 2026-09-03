/**
 * iOS AR via Apple's AR Quick Look.
 *
 * iPhone Safari has no WebXR, so the in-page AR scene cannot run there at all.
 * Quick Look is the only route, and it takes USDZ. Rather than shipping a
 * second copy of every model, the USDZ is generated in the browser from the
 * GLB we already serve — this is exactly what <model-viewer> does when
 * `quick-look` is set without an `ios-src`, and it means one asset per product.
 *
 * ponytail: generated on demand and cached in memory. If conversion ever
 * becomes the slow part, pre-build USDZ at upload time and serve it instead.
 */
import { Box3, CanvasTexture, Group, Vector3 } from 'three'
import type { Material, Mesh, MeshStandardMaterial, Object3D, Texture } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js'
import { groundingOffset } from './Model'
import { correctMetalness } from './materials'
import type { Product } from './products'

/** iPadOS reports itself as a Mac, so touch points are the reliable tell. */
export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/** Quick Look only exists in Safari's own web view. */
export const supportsQuickLook = () =>
  isIOS() && document.createElement('a').relList?.supports?.('ar') === true

export const isAndroid = () => /android/i.test(navigator.userAgent)

/**
 * Intent URL that hands a model to Android's Scene Viewer.
 *
 * Scene Viewer reads glTF as 1 unit = 1 metre and takes no scale parameter, so
 * the file must already be at real size — see bake.ts. `resizable=false` stops
 * the user pinching a product away from its true dimensions, which is the whole
 * point of previewing it. It must be an absolute https URL: Scene Viewer is a
 * separate app and cannot read blob: or relative URLs.
 */
export function sceneViewerUrl(absoluteGlbUrl: string, title: string) {
  const params = new URLSearchParams({
    file: absoluteGlbUrl,
    mode: 'ar_preferred',
    resizable: 'false',
    title,
  })
  const fallback = encodeURIComponent(location.href)
  return (
    `intent://arvr.google.com/scene-viewer/1.0?${params}` +
    `#Intent;scheme=https;package=com.google.ar.core;action=android.intent.action.VIEW;` +
    `S.browser_fallback_url=${fallback};end;`
  )
}

const cache = new Map<string, string>()

/**
 * Build a Quick Look–ready USDZ for a product and return an object URL.
 * Scales to real-world metres and grounds the model, so it arrives in the room
 * at the right size sitting on the floor rather than floating or huge.
 */
/**
 * Quick Look renders with its own filmic tone curve and USD has no exposure
 * control, so the same model reads slightly darker on iOS than in our own
 * renderer — which on top of that lifts blacks for the camera match (see
 * grain.ts) and has no way to do so here. The only lever left is the material,
 * so the base colour gets a gentle lift, shaped as a gamma: pure black and
 * pure white stay exactly where they are, so nothing can clip, and the
 * mid-tones where the difference actually shows come up.
 *
 * ponytail: a calibration constant, not a measurement — Apple does not publish
 * the curve. 1.08 lifts mid-grey by about five per cent, which is the size of
 * the reported difference. This is the knob if iOS still reads dark.
 */
export const IOS_MIDTONE_LIFT = 1.08

/** 8-bit lookup for the lift, so a 2K texture is a table read per channel. */
export const midtoneLut = (lift: number) =>
  Uint8Array.from({ length: 256 }, (_, i) => Math.round(255 * (i / 255) ** (1 / lift)))

const LUT = midtoneLut(IOS_MIDTONE_LIFT)
const lifted = new WeakMap<Texture, Texture>()

function liftTexture(source: Texture): Texture | null {
  const cached = lifted.get(source)
  if (cached) return cached
  const image = source.image as CanvasImageSource & { width?: number; height?: number }
  if (!image?.width || !image?.height) return null

  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(image, 0, 0)

  let pixels
  try {
    pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
  } catch {
    // a cross-origin texture taints the canvas; better unlifted than broken
    return null
  }
  const data = pixels.data
  for (let i = 0; i < data.length; i += 4) {
    data[i] = LUT[data[i]]
    data[i + 1] = LUT[data[i + 1]]
    data[i + 2] = LUT[data[i + 2]]
  }
  ctx.putImageData(pixels, 0, 0)

  const texture = new CanvasTexture(canvas)
  // CanvasTexture flips by default and glTF textures do not; the exporter
  // reads flipY to decide whether to flip again, so it has to carry over
  texture.flipY = source.flipY
  texture.colorSpace = source.colorSpace
  texture.wrapS = source.wrapS
  texture.wrapT = source.wrapT
  texture.repeat.copy(source.repeat)
  texture.offset.copy(source.offset)
  texture.channel = source.channel
  lifted.set(source, texture)
  return texture
}

/**
 * The materials Quick Look is handed are not the ones our own renderer draws:
 * the export loads its own copy of the glTF, so every correction made on the
 * WebXR path had been skipped here. A model shipping a small non-zero metalness
 * loses that share of its diffuse albedo, which is a slice of the darkness on
 * iOS all by itself — the Double Stack's vegetables and lettuce ship 0.12 and
 * 0.07 and were rendering that much flatter than on Android.
 */
function prepareForQuickLook(root: Object3D) {
  const seen = new Set<Material>()
  root.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!material || seen.has(material)) continue
      seen.add(material)
      const m = material as MeshStandardMaterial
      if (!m.isMeshStandardMaterial) continue
      correctMetalness(m)
      if (m.map) {
        const texture = liftTexture(m.map)
        if (texture) m.map = texture
      } else {
        // untextured materials carry their colour linearly, where the same
        // gamma still lifts the middle and pins both ends
        const lift = (v: number) => v ** (1 / IOS_MIDTONE_LIFT)
        m.color.setRGB(lift(m.color.r), lift(m.color.g), lift(m.color.b))
      }
    }
  })
}

export async function usdzUrl(product: Product): Promise<string> {
  const hit = cache.get(product.id)
  if (hit) return hit

  const gltf = await new GLTFLoader().loadAsync(product.url)
  const root = gltf.scene

  const box = new Box3().setFromObject(root)
  if (!box.isEmpty()) {
    const o = groundingOffset(box.min, box.max)
    root.position.set(o.x, o.y, o.z)
  }
  // Quick Look reads the scene in metres, so bake the product scale in.
  const holder = new Group()
  holder.scale.setScalar(product.scale || 1)
  holder.add(root)

  prepareForQuickLook(root)

  // The exporter halves anything above 1K by default, so the normal and
  // roughness maps iOS was being handed had half the detail Android renders.
  // Measured on the Double Stack: 9.7MB against 16.2MB, and the export takes
  // the same time either way, since PNG encoding dominates. Base colour is
  // untouched at 1024 — only maps authored larger gain anything.
  const arraybuffer = await new USDZExporter().parseAsync(holder, { maxTextureSize: 2048 })
  const url = URL.createObjectURL(new Blob([arraybuffer], { type: 'model/vnd.usdz+zip' }))
  cache.set(product.id, url)
  return url
}

/** Real-world size in metres, for the caveat shown next to the AR button. */
export const realSize = (min: Vector3, max: Vector3, scale: number) =>
  new Vector3().subVectors(max, min).multiplyScalar(scale)
