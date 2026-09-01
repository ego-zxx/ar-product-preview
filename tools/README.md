# tools

## obj2glb.mjs

Converts an OBJ to a GLB using the three.js already in this project — no extra
dependency. Scales the model to a real-world height and sits its base on `y=0`,
which is what the AR scene assumes for every product.

```bash
MATERIALS="Mat_4=#2a1408:0.12" \
  node tools/obj2glb.mjs input.obj output.glb 0.093
```

`MATERIALS` maps `usemtl` names to `colour:roughness`; anything unlisted gets a
neutral ceramic. Cinema 4D and Blender OBJ exports often ship without a usable
MTL, so materials are assigned here rather than imported.

It prints the source bounds and the final size in cm — check those before
uploading, since a model at the wrong scale is the single most common reason an
object looks wrong in AR.
