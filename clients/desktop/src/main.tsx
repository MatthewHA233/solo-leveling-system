import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 钛合金机体用的三款字体打进包里（Google Fonts 在国内不稳，点阵 LED 字丢了整套质感就塌）
import '@fontsource/chakra-petch/500.css'
import '@fontsource/chakra-petch/600.css'
import '@fontsource/chakra-petch/700.css'
import '@fontsource/doto/700.css'
import '@fontsource/doto/900.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './index.css'
import './styles/titanium.css'
import App from './App.tsx'
import CameraWindow from './components/CameraWindow.tsx'
import FairyWindow from './components/FairyWindow.tsx'
import DebugPrepWindow from './components/DebugPrepWindow.tsx'

const isCameraWindow    = window.location.hash === '#camera'
const isFairyWindow     = window.location.hash === '#fairy'
const isDebugPrepWindow = window.location.hash === '#debug-prep'

// Fairy 窗口：React 渲染前同步清除背景，防止 index.css 的暗色 body 背景闪出矩形
if (isFairyWindow) {
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
}

// Windows 主窗口：无系统标题栏 + 窗口底透明（lib.rs），由 .frameless 把机体四角挖空（styles/topbar.css）
if (!isFairyWindow && !isCameraWindow && !isDebugPrepWindow && navigator.userAgent.includes('Windows')) {
  document.documentElement.classList.add('frameless')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isFairyWindow
      ? <FairyWindow />
      : isCameraWindow
        ? <CameraWindow />
        : isDebugPrepWindow
          ? <DebugPrepWindow />
          : <App />}
  </StrictMode>,
)
