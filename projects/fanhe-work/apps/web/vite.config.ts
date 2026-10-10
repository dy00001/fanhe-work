import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Bind the IPv4 loopback explicitly. Vite defaults to the `localhost`
    // hostname, which on Windows resolves to the IPv6 loopback ::1 only, so
    // the server would be unreachable at 127.0.0.1 and would not match the
    // API host below. Pinning the address keeps both ends on the same stack.
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // The API runs on the loopback interface only. Proxying through the dev
      // server keeps the browser origin single, so no CORS policy is needed
      // during development.
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
})
