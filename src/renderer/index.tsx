import { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from './editor/Editor'
import { Home } from './home/Home'
import { AccessProvider } from './home/plan'
import { blockFileDrops } from './no-file-drop'
import './styles/tokens.css'
import './styles/app.css'
import './styles/editor.css'

blockFileDrops(window)
document.documentElement.dataset.platform = navigator.userAgent.includes('Mac') ? 'mac' : 'other'

function App() {
  const [opened, setOpened] = useState<{ dir: string; warnings: string[] } | null>(null)
  const open = useCallback((dir: string, warnings: string[] = []) => setOpened({ dir, warnings }), [])
  const goHome = useCallback(() => setOpened(null), [])
  return (
    <AccessProvider>
      {opened ? <Editor dir={opened.dir} warnings={opened.warnings} onExit={goHome} /> : <Home onOpen={open} />}
    </AccessProvider>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
