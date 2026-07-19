import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
      '/confirm': 'http://localhost:3000',
      '/manage': 'http://localhost:3000',
      '/unsubscribe': 'http://localhost:3000',
    },
  },
  test: {
    root: process.cwd(),
  },
})
