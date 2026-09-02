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
import { Box3, Group, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js'
import { groundingOffset } from './ARScene'
import type { Product } from './products'

/** iPadOS reports itself as a Mac, so touch points are the reliable tell. */
export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/** Quick Look only exists in Safari's own web view. */
export const supportsQuickLook = () =>
  isIOS() && document.createElement('a').relList?.supports?.('ar') === true

const cache = new Map<string, string>()

/**
 * Build a Quick Look–ready USDZ for a product and return an object URL.
 * Scales to real-world metres and grounds the model, so it arrives in the room
 * at the right size sitting on the floor rather than floating or huge.
 */
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

  const arraybuffer = await new USDZExporter().parseAsync(holder)
  const url = URL.createObjectURL(new Blob([arraybuffer], { type: 'model/vnd.usdz+zip' }))
  cache.set(product.id, url)
  return url
}

/** Real-world size in metres, for the caveat shown next to the AR button. */
export const realSize = (min: Vector3, max: Vector3, scale: number) =>
  new Vector3().subVectors(max, min).multiplyScalar(scale)
