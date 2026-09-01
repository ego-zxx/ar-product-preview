import './ios.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Admin } from './Admin'

// The /admin path route needs a server rewrite. The hash route needs nothing,
// so it works on any static host — cPanel, a subdirectory, anywhere.
const isAdmin =
  location.pathname.replace(/\/$/, '').endsWith('/admin') || location.hash.startsWith('#/admin')

createRoot(document.getElementById('root')!).render(isAdmin ? <Admin /> : <App />)
