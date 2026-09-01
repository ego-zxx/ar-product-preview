import { DoubleSide, Vector2 } from 'three'

const chrome = { color: '#e8eaec', metalness: 1, roughness: 0.07 }

/** Chrome basin mixer, ~20cm tall, authored in real metres. */
export function Faucet() {
  return (
    <group>
      <mesh position={[0, 0.005, 0]} castShadow>
        <cylinderGeometry args={[0.035, 0.04, 0.01, 48]} />
        <meshStandardMaterial {...chrome} />
      </mesh>
      <mesh position={[0, 0.085, 0]}>
        <cylinderGeometry args={[0.014, 0.016, 0.15, 32]} />
        <meshStandardMaterial {...chrome} />
      </mesh>
      <mesh position={[0, 0.16, 0.05]} rotation={[0, -Math.PI / 2, 0]}>
        <torusGeometry args={[0.05, 0.011, 20, 32, Math.PI / 2]} />
        <meshStandardMaterial {...chrome} />
      </mesh>
      <mesh position={[0, 0.135, 0.1]}>
        <cylinderGeometry args={[0.011, 0.013, 0.05, 24]} />
        <meshStandardMaterial {...chrome} />
      </mesh>
      <mesh position={[0.03, 0.165, 0]} rotation={[0, 0, -0.5]}>
        <boxGeometry args={[0.06, 0.008, 0.014]} />
        <meshStandardMaterial color="#1a1c1e" metalness={0.2} roughness={0.7} />
      </mesh>
    </group>
  )
}

/**
 * Ceramic mug — 9.5cm tall, 8.2cm across, real mug dimensions.
 * Lathed shell (outer wall up, inner wall back down) so it reads as a hollow
 * vessel from every angle, which is the point: it's the test object for whether
 * placement is genuinely 3D.
 */
const CUP_POINTS = ([
  [0.0, 0.0],
  [0.036, 0.0],
  [0.0385, 0.004],
  [0.0395, 0.02],
  [0.0405, 0.05],
  [0.0405, 0.082],
  [0.041, 0.095], // outer rim
  [0.0375, 0.095], // rim lip
  [0.037, 0.082],
  [0.0365, 0.05],
  [0.0355, 0.02],
  [0.033, 0.009], // inner floor
  [0.0, 0.009],
] as [number, number][]).map(([x, y]) => new Vector2(x, y))

export function CoffeeCup() {
  return (
    <group>
      <mesh>
        <latheGeometry args={[CUP_POINTS, 56]} />
        <meshStandardMaterial color="#f4f1ec" roughness={0.28} metalness={0.02} side={DoubleSide} />
      </mesh>
      {/* handle: open loop on +X, tilted slightly like a real mug */}
      <mesh position={[0.0405, 0.055, 0]} rotation={[Math.PI / 2, 0, -Math.PI / 2]}>
        <torusGeometry args={[0.026, 0.0058, 16, 40, Math.PI * 1.25]} />
        <meshStandardMaterial color="#f4f1ec" roughness={0.28} metalness={0.02} />
      </mesh>
      {/* coffee surface, sat below the rim */}
      <mesh position={[0, 0.078, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.0353, 48]} />
        <meshStandardMaterial color="#2a1408" roughness={0.13} metalness={0.0} />
      </mesh>
    </group>
  )
}
