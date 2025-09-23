import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: (() => {
      // Allow overriding backend port via env to avoid proxy mismatches
      const backendPort = process.env.VITE_SERVER_PORT || process.env.SERVER_PORT || '8080'
      const target = `http://localhost:${backendPort}`
      return {
        '/bench': target,
        '/results': target,
        '/metrics': target,
        '/logs': target,
        '/api': target,
      }
    })(),
  }
})

