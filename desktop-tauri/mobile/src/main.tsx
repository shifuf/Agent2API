import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installDesktopBridge } from './core/desktop-bridge'
import './styles/mobile.css'
import './ui/flclash.css'
import './ui/flclash-controls.css'

const container = document.getElementById('root')
installDesktopBridge()
if (container) {
  createRoot(container).render(<App />)
}
