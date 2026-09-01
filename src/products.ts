import { api, assetUrl } from './api'

export type Spec = { label: string; value: string }

export type Product = {
  id: string
  name: string
  category: string
  url: string
  emoji: string
  scale: number
  price?: string
  description?: string
  dimensions?: string
  specs?: Spec[]
}

// Always available so the app works before anything is uploaded.
export const BUILTIN: Product[] = [
  {
    id: 'builtin-faucet',
    name: 'Basin Mixer',
    category: 'Faucets',
    url: 'builtin:faucet',
    emoji: '🚰',
    scale: 1,
    price: '£129',
    dimensions: '200 mm H × 100 mm D',
    description:
      'Single-lever basin mixer in polished chrome. The curved spout clears a standard basin, and the lever falls to hand from either side.',
    specs: [
      { label: 'Finish', value: 'Polished chrome' },
      { label: 'Material', value: 'Solid brass' },
      { label: 'Spout reach', value: '100 mm' },
      { label: 'Warranty', value: '10 years' },
    ],
  },
  {
    id: 'builtin-cup',
    name: 'Coffee Cup',
    category: 'Test',
    url: 'builtin:cup',
    emoji: '☕',
    scale: 1,
    price: '£12',
    dimensions: '95 mm H × 82 mm Ø',
    description:
      'Stoneware mug used to check placement and scale — its handle and hollow interior make it obvious from every angle whether the object is really sitting in the room.',
    specs: [
      { label: 'Capacity', value: '350 ml' },
      { label: 'Material', value: 'Glazed stoneware' },
      { label: 'Calories', value: '2 kcal (black)' },
      { label: 'Dishwasher safe', value: 'Yes' },
    ],
  },
]

export async function fetchProducts(): Promise<Product[]> {
  try {
    const res = await fetch(api('/api/products'))
    const remote: Product[] = res.ok ? await res.json() : []
    // rewrite /models/... to the API host
    return [...BUILTIN, ...remote.map((p) => ({ ...p, url: assetUrl(p.url) }))]
  } catch {
    return BUILTIN
  }
}
