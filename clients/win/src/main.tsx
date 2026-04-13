import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import CameraWindow from './components/CameraWindow.tsx'
import FairyWindow from './components/FairyWindow.tsx'

const isCameraWindow = window.location.hash === '#camera'
const isFairyWindow  = window.location.hash === '#fairy'

// Fairy 窗口：React 渲染前同步清除背景，防止 index.css 的暗色 body 背景闪出矩形
if (isFairyWindow) {
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isFairyWindow
      ? <FairyWindow />
      : isCameraWindow
        ? <CameraWindow />
        : <App />}
  </StrictMode>,
)
