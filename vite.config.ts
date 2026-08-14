import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 生产走 file:// 加载，必须用相对 base，否则静态资源 404
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  }
})
