import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mobileRoot = path.resolve(__dirname, '../..')
const webRoot = path.join(__dirname, '.cache', 'web')

export default defineConfig({
  root: webRoot,
  cacheDir: path.join(__dirname, '.cache', 'vite'),
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: path.join(__dirname, 'src/react-native-shim.ts') },
      { find: /^react-native-svg$/, replacement: path.join(__dirname, 'src/react-native-svg-shim.tsx') },
      { find: /^react-native-safe-area-context$/, replacement: path.join(__dirname, 'src/react-native-safe-area-context-shim.ts') },
      { find: /^react$/, replacement: path.join(mobileRoot, 'node_modules/react') },
      { find: /^react\/jsx-runtime$/, replacement: path.join(mobileRoot, 'node_modules/react/jsx-runtime.js') },
    ],
    dedupe: ['react', 'react-dom', 'react-native-web'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom/client', 'react-native-web'],
    exclude: ['react-native'],
  },
  define: {
    __DEV__: JSON.stringify(true),
  },
  server: {
    host: '0.0.0.0',
    port: 8766,
    strictPort: false,
    fs: {
      allow: [mobileRoot, __dirname, webRoot],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:8767',
        changeOrigin: true,
      },
    },
  },
})
