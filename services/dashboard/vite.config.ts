import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tailwind runs as a Vite plugin. An empty PostCSS config stops Vite from
  // picking up a PostCSS config from some parent folder on the build machine.
  css: { postcss: {} },
  // "@/components/ui/button" -> src/components/ui/button (shadcn/ui convention).
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    // `npm run dev` talks to the gateway running in the local cluster.
    proxy: {
      '/api': { target: 'http://dashboard.localtest.me', changeOrigin: true },
      '/mcp': { target: 'http://dashboard.localtest.me', changeOrigin: true },
    },
  },
})
