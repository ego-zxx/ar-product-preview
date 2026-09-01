import './ios.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Admin } from './Admin'

createRoot(document.getElementById('root')!).render(location.pathname === '/admin' ? <Admin /> : <App />)
