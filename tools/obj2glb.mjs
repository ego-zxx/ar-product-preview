// OBJ -> GLB using the three.js already in this project. No new dependency.
// usage: node obj2glb.mjs <in.obj> <out.glb> <targetHeightMetres>
import { readFileSync, writeFileSync } from 'node:fs'
import { Box3, Vector3, MeshStandardMaterial, Group, DoubleSide } from 'three'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'

// GLTFExporter reaches for a browser FileReader when it serialises the binary
// chunk. Node has Blob but not FileReader, so supply the two methods it uses.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    onload = null
    onloadend = null
    onerror = null
    result = null
    #done() {
      this.onload?.({ target: this })
      this.onloadend?.({ target: this }) // the exporter listens on this one
    }
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf
        this.#done()
      }, this.onerror)
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`
        this.#done()
      }, this.onerror)
    }
  }
}

const [, , input, output, targetH] = process.argv
const obj = new OBJLoader().parse(readFileSync(input, 'utf8'))

// Report what came in, so scaling decisions aren't blind.
const raw = new Box3().setFromObject(obj)
const rawSize = raw.getSize(new Vector3())
console.log('source bounds:', [...rawSize.toArray()].map((n) => n.toFixed(1)).join(' x '))
console.log('materials:', [...new Set(obj.children.map((c) => c.material?.name))].join(', '))

// Scale to a real-world height and sit the base on y=0, which is what the AR
// scene assumes for every product.
const scale = Number(targetH) / rawSize.y
obj.scale.setScalar(scale)
obj.updateMatrixWorld(true)

const scaled = new Box3().setFromObject(obj)
const centre = scaled.getCenter(new Vector3())
const root = new Group()
obj.position.set(-centre.x, -scaled.min.y, -centre.z)
root.add(obj)
root.updateMatrixWorld(true)

// The OBJ ships no MTL, only usemtl names, so materials are assigned here.
// MATERIALS env: "Mat_4=#2a1408:0.12,Mat_1=#f4f1ec:0.3"  (name=colour:roughness)
const overrides = Object.fromEntries(
  (process.env.MATERIALS ?? '').split(',').filter(Boolean).map((entry) => {
    const [name, rest] = entry.split('=')
    const [colour, rough] = rest.split(':')
    return [name, { colour, rough: Number(rough) }]
  }),
)
const ceramic = { colour: '#f4f1ec', rough: 0.35 }
obj.traverse((o) => {
  if (!o.isMesh) return
  const spec = overrides[o.material?.name] ?? ceramic
  o.material = new MeshStandardMaterial({
    color: spec.colour,
    roughness: spec.rough,
    metalness: 0.02,
    side: DoubleSide, // Cinema4D lofts are single-sided; a cup must have an inside
  })
  o.geometry.computeVertexNormals()
})

const final = new Box3().setFromObject(root)
const size = final.getSize(new Vector3())
console.log('output size  :', [...size.toArray()].map((n) => (n * 100).toFixed(1)).join(' x '), 'cm')
console.log('base sits at :', final.min.y.toFixed(4), 'm')

// parse() resolves asynchronously; await it or the process exits first.
const glb = await new Promise((resolve, reject) =>
  new GLTFExporter().parse(root, resolve, reject, { binary: true }),
)
writeFileSync(output, Buffer.from(glb))
console.log('wrote', output, (glb.byteLength / 1024).toFixed(0) + 'KB')
