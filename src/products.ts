import { api, assetUrl } from './api'

export type Product = {
  id: string
  name: string
  category: string
  url: string
  emoji: string
  scale: number
}

// Always available so the app works before anything is uploaded.
export const BUILTIN: Product[] = [
  { id: 'builtin-faucet', name: 'Basin Mixer', category: 'Faucets', url: 'builtin:faucet', emoji: '🚰', scale: 1 },
  { id: 'builtin-cup', name: 'Coffee Cup', category: 'Test', url: 'builtin:cup', emoji: '☕', scale: 1 },
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
