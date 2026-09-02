import { Color, MeshStandardMaterial, type Material } from 'three'

/**
 * Corrections applied to uploaded models, for the two faults that most often
 * make a product read as computer-generated.
 */

/**
 * PBR metalness is meant to be binary: a surface is a metal or it is not.
 * Intermediate values are almost always a modelling slip, and on organic
 * subjects — food, fabric, wood — they produce a waxy, plastic sheen. A real
 * metal sits at 0.8-1.0, so anything below this is corrected to a dielectric.
 * Materials carrying a metalnessMap are left alone: there the author meant it.
 */
export const METAL_FLOOR = 0.3

/** How far the colour map may push roughness either side of its base value. */
export const ROUGHNESS_VARIATION = 0.35

export function correctMetalness(m: MeshStandardMaterial): boolean {
  if (m.metalnessMap || m.metalness === 0 || m.metalness >= METAL_FLOOR) return false
  m.metalness = 0
  return true
}

/**
 * Break up uniform gloss.
 *
 * A model without a roughness map has one gloss value across the whole
 * surface, so every part of a bun is equally shiny. Real surfaces vary
 * constantly, and that uniformity is a strong CG tell. Where no roughness map
 * exists, the colour map's own luminance stands in for one: darker, dirtier
 * areas read as rougher, lighter areas as smoother. Not physically derived,
 * but far closer than a constant — and only applied where the author supplied
 * nothing better.
 */
/**
 * Materials are shared between clones — the product page and the AR scene load
 * the same cached glTF — so this can be reached more than once for the same
 * material. Without a guard each pass re-injects `uniform float uRoughVary`,
 * and a duplicate declaration fails to compile: the object vanishes while its
 * shadow, drawn by a separate depth pass, remains.
 */
const varied = new WeakSet<MeshStandardMaterial>()

export function varyRoughness(m: MeshStandardMaterial): boolean {
  if (varied.has(m) || m.roughnessMap || !m.map) return false
  varied.add(m)
  const previous = m.onBeforeCompile
  m.onBeforeCompile = function (shader, renderer) {
    previous?.call(this, shader, renderer)
    shader.uniforms.uRoughVary = { value: ROUGHNESS_VARIATION }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uRoughVary;')
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        {
          // diffuseColor is already sampled by map_fragment above
          float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          roughnessFactor = clamp(roughnessFactor + (0.5 - lum) * uRoughVary, 0.04, 1.0);
        }`,
      )
  }
  m.needsUpdate = true
  return true
}

/** Returns what was changed, for reporting in the diagnostics readout. */
export function improveMaterial(material: Material) {
  const m = material as MeshStandardMaterial
  if (!m.isMeshStandardMaterial) return { metal: false, rough: false }
  return { metal: correctMetalness(m), rough: varyRoughness(m) }
}

/**
 * Colour of the shadow the object casts on the real surface. A photographed
 * shadow is never black: it is the surface lit by ambient alone, so it takes
 * the ambient's colour. `EstimatedLighting` writes the room's ambient here;
 * black until an estimate exists. Kept dark: at a quarter of the ambient the
 * shadow was too pale to ground the object at all.
 */
export const shadowTint = new Color(0, 0, 0)
