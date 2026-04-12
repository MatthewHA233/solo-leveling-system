import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import CameraWindow from './components/CameraWindow.tsx'

const isCameraWindow = window.location.hash === '#camera'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isCameraWindow ? <CameraWindow /> : <App />}
  </StrictMode>,
)
