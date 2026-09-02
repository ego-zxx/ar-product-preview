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

// Built-in demo models were React components with no file behind them, so they
// could not be handed to a system AR viewer — a product you cannot place is a
// dead end now that placing is the whole point. The catalogue is the API's.
export async function fetchProducts(): Promise<Product[]> {
  try {
    const res = await fetch(api('/api/products'))
    const remote: Product[] = res.ok ? await res.json() : []
    // rewrite /models/... to the API host
    return remote.map((p) => ({ ...p, url: assetUrl(p.url) }))
  } catch {
    return []
  }
}
