import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Keep the browser's Host header: the server's CSRF check compares Origin with Host.
const backend = { target: 'http://localhost:3001', changeOrigin: false }

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': backend,
      '/mcp': backend,
    },
  },
})
