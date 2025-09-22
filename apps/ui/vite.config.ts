import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/bench': 'http://localhost:8080',
      '/results': 'http://localhost:8080',
      '/metrics': 'http://localhost:8080',
      '/logs': 'http://localhost:8080',
      '/api': 'http://localhost:8080'
    }
  }
})

