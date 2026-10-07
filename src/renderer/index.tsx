import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('renderer: #root 缺失')
createRoot(root).render(<App />)
