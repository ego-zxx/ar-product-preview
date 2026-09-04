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
import { Box3, CanvasTexture, Group, NoColorSpace, Vector3 } from 'three'
import type { Material, Mesh, MeshStandardMaterial, Object3D, Texture } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js'
import { unzipSync, zipSync } from 'three/addons/libs/fflate.module.js'
import { groundingOffset } from './Model'
import { correctMetalness, ROUGHNESS_VARIATION } from './materials'
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
 * the curve, and none of the Android work can help here because Quick Look
 * runs none of our code. Measured on the Double Stack's bun texture, whose
 * source mean is 128.4: 1.08 gave 133.8 and read as no change at all, 1.3 gave
 * 150.4 and still read dark, 1.5 gives 161.4. Raised a step at a time because
 * overshooting a lift on albedo washes a model out and cannot be undone by the
 * renderer afterwards.
 *
 * `?ioslift=1.5` overrides it, so the right value can be found on the device in
 * one sitting instead of one round trip per guess. Clamped to sane bounds.
 */
/**
 * A tuning knob readable from the URL, so these can be found on the device
 * rather than one round trip per guess.
 *
 * Absent and empty are both rejected before Number sees them: Number(null) and
 * Number('') are 0, which sails through any bound starting at zero and would
 * silently switch a feature off for everyone who never asked for it.
 */
export function readOverride(name: string, lo: number, hi: number, fallback: number) {
  const raw = new URLSearchParams(location.search).get(name)
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= lo && value <= hi ? value : fallback
}

/**
 * Ambient fill, as a fraction of a material's own colour.
 *
 * Quick Look honours every UsdPreviewSurface input, and emissiveColor is the
 * only one that does not depend on ARKit's estimate: it is added whatever the
 * room does. Lifting the albedo cannot reach a shadow, because albedo is
 * multiplied by light and there is none there — which is why the mid-tone lift
 * kept helping a little and never finishing the job. This lifts exactly the
 * places the light does not reach, in the material's own colour rather than a
 * grey wash, and is the compositor's shadow lift rather than a relight.
 *
 * ponytail: kept small on purpose. Emissive is self-illumination, and past a
 * point food stops looking lit and starts looking radioactive. ?iosfill=0
 * turns it off, ?iosfill=0.15 pushes it.
 */
export const IOS_FILL = readOverride('iosfill', 0, 0.3, 0.08)

/**
 * How much of a baked occlusion map to keep.
 *
 * three applies aoMap to indirect diffuse alone; Quick Look's occlusion input
 * attenuates more of the lighting than that, so a model carrying an AO map —
 * the Classic Cheeseburger does — comes out darker on iOS than on Android from
 * the same texture. Softening it toward white brings the two back in line.
 */
export const IOS_OCCLUSION = 0.55

export const IOS_MIDTONE_LIFT = readOverride('ioslift', 1, 2, 1.5)

/** 8-bit lookup for the lift, so a 2K texture is a table read per channel. */
export const midtoneLut = (lift: number) =>
  Uint8Array.from({ length: 256 }, (_, i) => Math.round(255 * (i / 255) ** (1 / lift)))

const LUT = midtoneLut(IOS_MIDTONE_LIFT)
const lifted = new WeakMap<Texture, Texture>()
/** Average colour of a base map, linear, for the fill to take its hue from. */
const meanColour = new WeakMap<Texture, [number, number, number]>()

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
  let sumR = 0
  let sumG = 0
  let sumB = 0
  for (let i = 0; i < data.length; i += 4) {
    // measured before the lift, so the fill follows the material as authored
    sumR += TO_LINEAR[data[i]]
    sumG += TO_LINEAR[data[i + 1]]
    sumB += TO_LINEAR[data[i + 2]]
    data[i] = LUT[data[i]]
    data[i + 1] = LUT[data[i + 1]]
    data[i + 2] = LUT[data[i + 2]]
  }
  ctx.putImageData(pixels, 0, 0)
  const count = data.length / 4
  meanColour.set(source, [sumR / count, sumG / count, sumB / count])

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

/** sRGB byte to linear, so luminance is measured the way the shader measures it. */
const TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const v = i / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
})

/**
 * Bake the gloss variation into a texture, because USD has no shader hook.
 *
 * `varyRoughness` breaks up the flat single roughness value a model without a
 * roughness map would otherwise have, reading the colour map's own luminance as
 * a stand-in. It does that in the fragment shader, which Quick Look never runs,
 * so iOS was left with one gloss value across a whole bun — the plastic-toy
 * look. The same formula evaluated per texel and written out as a real
 * roughness map gives iOS the identical treatment.
 *
 * The value goes in green because that is where glTF keeps roughness and what
 * the USD exporter connects, and the texture is raw data rather than colour, so
 * it must not be tagged sRGB.
 */
function bakedRoughness(map: Texture, base: number): Texture | null {
  const image = map.image as CanvasImageSource & { width?: number; height?: number }
  if (!image?.width || !image?.height) return null
  const scale = Math.min(1, 1024 / Math.max(image.width, image.height))

  const source = document.createElement('canvas')
  source.width = Math.max(1, Math.round(image.width * scale))
  source.height = Math.max(1, Math.round(image.height * scale))
  const ctx = source.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(image, 0, 0, source.width, source.height)

  let pixels
  try {
    pixels = ctx.getImageData(0, 0, source.width, source.height)
  } catch {
    return null
  }
  const data = pixels.data
  for (let i = 0; i < data.length; i += 4) {
    const lum =
      0.299 * TO_LINEAR[data[i]] + 0.587 * TO_LINEAR[data[i + 1]] + 0.114 * TO_LINEAR[data[i + 2]]
    const rough = Math.min(1, Math.max(0.04, base + (0.5 - lum) * ROUGHNESS_VARIATION))
    const byte = Math.round(rough * 255)
    data[i] = byte
    data[i + 1] = byte
    data[i + 2] = byte
    data[i + 3] = 255
  }
  ctx.putImageData(pixels, 0, 0)

  const texture = new CanvasTexture(source)
  texture.flipY = map.flipY
  // data, not colour: tagging this sRGB would skew every roughness value
  texture.colorSpace = NoColorSpace
  texture.wrapS = map.wrapS
  texture.wrapT = map.wrapT
  texture.repeat.copy(map.repeat)
  texture.offset.copy(map.offset)
  texture.channel = map.channel
  return texture
}

/** Lift a baked occlusion map toward white, keeping IOS_OCCLUSION of its bite. */
function softenOcclusion(map: Texture): Texture | null {
  const image = map.image as CanvasImageSource & { width?: number; height?: number }
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
    return null
  }
  const data = pixels.data
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) data[i + c] = 255 - (255 - data[i + c]) * IOS_OCCLUSION
  }
  ctx.putImageData(pixels, 0, 0)
  const texture = new CanvasTexture(canvas)
  texture.flipY = map.flipY
  texture.colorSpace = NoColorSpace
  texture.wrapS = map.wrapS
  texture.wrapT = map.wrapT
  texture.repeat.copy(map.repeat)
  texture.offset.copy(map.offset)
  texture.channel = map.channel
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
      if (m.map && !m.roughnessMap) {
        const roughness = bakedRoughness(m.map, m.roughness ?? 1)
        if (roughness) {
          m.roughnessMap = roughness
          // the exporter connects roughness straight to the map and ignores
          // the scalar, so the base value is already baked into the texture
        }
      }
      if (m.aoMap) {
        const softened = softenOcclusion(m.aoMap)
        if (softened) m.aoMap = softened
      }
      if (m.map) {
        const original = m.map
        const texture = liftTexture(original)
        if (texture) m.map = texture
        const mean = meanColour.get(original)
        // fill in the material's own colour, so a shadow lifts warm on a bun
        // and green on lettuce rather than toward a uniform grey
        if (mean && IOS_FILL > 0) {
          m.emissive.setRGB(mean[0] * IOS_FILL, mean[1] * IOS_FILL, mean[2] * IOS_FILL)
        }
      } else {
        // untextured materials carry their colour linearly, where the same
        // gamma still lifts the middle and pins both ends
        const lift = (v: number) => v ** (1 / IOS_MIDTONE_LIFT)
        m.color.setRGB(lift(m.color.r), lift(m.color.g), lift(m.color.b))
        if (IOS_FILL > 0) m.emissive.copy(m.color).multiplyScalar(IOS_FILL)
      }
    }
  })
}

/**
 * Tell Quick Look which lighting environment to render with.
 *
 * This is the one piece of AR lighting on iOS that is ours to set, and it was
 * being left to chance. Apple ships two image-based lighting environments and
 * picks between them from `preferredIblVersion` in the asset's own metadata:
 * 1 is the original, 2 is the brighter, higher-contrast one added in iOS 16,
 * and 0 means guess from the asset's creation date. three's exporter writes no
 * such key, so every model we generated fell to the guess — and a file built in
 * the browser has no creation date to guess from, which is a plausible reason
 * these have read dark on iOS however far the material was lifted.
 *
 * The exporter gives no hook for it, so the archive is reopened and its root
 * layer patched. Repacking has to reproduce the 64-byte alignment USDZ
 * requires, which is three's own loop, copied deliberately including its
 * quirks so the file stays byte-compatible with what Quick Look already
 * accepts from this exporter.
 */
const IBL_VERSION = 2

export function withIblVersion(archive: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const files: Record<string, Uint8Array> = unzipSync(archive)
  const root = Object.keys(files).find((name) => name.endsWith('.usda'))
  if (!root) return archive

  const text = new TextDecoder().decode(files[root])
  if (text.includes('preferredIblVersion')) return archive
  const patched = text.replace(
    'customLayerData = {',
    'customLayerData = {\n\t\tdictionary Apple = {\n\t\t\tint preferredIblVersion = ' +
      `${IBL_VERSION}\n\t\t}`,
  )
  // nothing to hook onto: leave the archive exactly as the exporter built it
  if (patched === text) return archive
  files[root] = new TextEncoder().encode(patched)

  const aligned: Record<string, Uint8Array | [Uint8Array, { extra: Record<number, Uint8Array> }]> =
    {}
  let offset = 0
  for (const name of Object.keys(files)) {
    const file = files[name]
    offset += 34 + name.length
    const remainder = offset & 63
    aligned[name] =
      remainder !== 4 ? [file, { extra: { 12345: new Uint8Array(64 - remainder) } }] : file
    offset = file.length
  }
  return zipSync(aligned, { level: 0 }) as Uint8Array<ArrayBuffer>
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
  const exported = await new USDZExporter().parseAsync(holder, { maxTextureSize: 2048 })
  const archive = withIblVersion(exported as unknown as Uint8Array<ArrayBuffer>)
  const url = URL.createObjectURL(new Blob([archive], { type: 'model/vnd.usdz+zip' }))
  cache.set(product.id, url)
  return url
}

/**
 * Quick Look's one interactive surface.
 *
 * iOS AR is a system screen: our DOM overlay, and with it the next-item arrow
 * Android gets, does not exist there and cannot. The single control Apple
 * allows is a banner along the bottom, configured through the fragment on the
 * model's own URL, and a tap on it arrives back on the launching anchor as a
 * `message` event. That banner is therefore both the label naming the dish and
 * the only way to step a menu without leaving AR.
 */
export const withBanner = (url: string, action: string, title: string, subtitle: string) =>
  `${url}#callToAction=${encodeURIComponent(action)}` +
  `&checkoutTitle=${encodeURIComponent(title)}` +
  `&checkoutSubtitle=${encodeURIComponent(subtitle)}`

/** What Quick Look posts back to the anchor when the banner is tapped. */
export const QUICK_LOOK_TAP = '_apple_ar_quicklook_button_tapped'

/** Real-world size in metres, for the caveat shown next to the AR button. */
export const realSize = (min: Vector3, max: Vector3, scale: number) =>
  new Vector3().subVectors(max, min).multiplyScalar(scale)
