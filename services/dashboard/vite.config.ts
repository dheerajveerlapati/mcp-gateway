import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // We use plain CSS. An empty config stops Vite from picking up a PostCSS
  // config from some parent folder on the build machine.
  css: { postcss: {} },
  server: {
    // `npm run dev` talks to the gateway running in the local cluster.
    proxy: {
      '/api': { target: 'http://dashboard.localtest.me', changeOrigin: true },
      '/mcp': { target: 'http://dashboard.localtest.me', changeOrigin: true },
    },
  },
})
