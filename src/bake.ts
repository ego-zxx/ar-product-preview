/**
 * Bake real-world scale and grounding into a GLB before it is stored.
 *
 * System AR viewers receive only a file URL: Android's Scene Viewer and iOS's
 * Quick Look both read glTF as 1 unit = 1 metre and cannot be told a scale
 * factor. A model stored at author scale therefore arrives absurdly sized —
 * a beer bottle 47 metres tall. Baking at upload makes every path agree, and
 * means `scale` is 1 for anything uploaded from here on.
 */
import { Box3, Group, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'

export type BakeResult = { blob: Blob; size: Vector3 }

export async function bakeRealScale(source: Blob, scale: number): Promise<BakeResult> {
  const url = URL.createObjectURL(source)
  try {
    const gltf = await new GLTFLoader().loadAsync(url)
    const root = gltf.scene

    // ground and centre in the model's own units, so the offset scales with it
    const box = new Box3().setFromObject(root)
    if (!box.isEmpty()) {
      const c = box.getCenter(new Vector3())
      root.position.set(-c.x, -box.min.y, -c.z)
    }

    const holder = new Group()
    holder.scale.setScalar(scale)
    holder.add(root)
    holder.updateMatrixWorld(true)

    const glb = (await new GLTFExporter().parseAsync(holder, { binary: true })) as ArrayBuffer
    const size = new Box3().setFromObject(holder).getSize(new Vector3())
    return { blob: new Blob([glb], { type: 'model/gltf-binary' }), size }
  } finally {
    URL.revokeObjectURL(url)
  }
}
