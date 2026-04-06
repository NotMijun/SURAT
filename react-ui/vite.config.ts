import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/react/',
  plugins: [react()],
  build: {
    outDir: 'dist/react',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:5173',
    },
  },
})
