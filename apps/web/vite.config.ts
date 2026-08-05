import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['brand/favicon.svg', 'brand/tern-mark.svg'],
      manifest: {
        name: 'TERN Status',
        short_name: 'TERN',
        description: 'Service status, live or historized.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        icons: [
          { src: 'brand/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'brand/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'brand/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // A status page must never serve a cached status. The shell is cached
        // so the app opens offline; the data always comes from the network, and
        // the UI shows its own offline state rather than a stale green tick.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /\/api\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // Same-origin in development, so the session cookie behaves exactly as it
      // will in production behind a single reverse proxy.
      '/api': {
        target: process.env.VITE_API_URL ?? 'http://localhost:3011',
        changeOrigin: true,
      },
    },
  },
})
