import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * What the admin prints under "sign out".
 *
 * Baked at build time rather than fetched: it describes the bundle the browser
 * is running, and a version served by the API would keep saying the new number
 * while a cached shell served the old one — the exact case someone reads this
 * line to diagnose.
 *
 * CI passes TERN_VERSION and TERN_REVISION; a local build falls back to the
 * package version and "dev", which is the honest answer for a bundle built from
 * a working tree.
 */
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string }

const VERSION = process.env.TERN_VERSION?.trim() || pkg.version
// Short hash: the full forty characters say nothing more to a human, and this
// sits in a 16rem rail.
const BUILD = process.env.TERN_REVISION?.trim().slice(0, 7) || 'dev'

function apiTarget(): string {
  return process.env.VITE_API_URL ?? 'http://localhost:3011'
}

export default defineConfig({
  define: {
    __TERN_VERSION__: JSON.stringify(VERSION),
    __TERN_BUILD__: JSON.stringify(BUILD),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['brand/favicon.svg', 'brand/tern-mark.svg', 'brand/tern-badge.svg'],
      manifest: {
        name: 'TERN Status',
        short_name: 'TERN',
        description: 'Service status, live or historized.',
        theme_color: '#0D2A3F',
        background_color: '#0D2A3F',
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
      /*
       * Everything else the API serves outside `/api`, or the dev server hands
       * back index.html and the caller gets a page where it expected a file.
       *
       * That is not cosmetic: `curl … /install.sh | sh` then pipes HTML into a
       * shell, which fails with a syntax error that says nothing about the
       * cause. Each of these is a real endpoint with a non-HTML body.
       */
      '/install.sh': { target: apiTarget(), changeOrigin: true },
      '/install.ps1': { target: apiTarget(), changeOrigin: true },
      '/badge': { target: apiTarget(), changeOrigin: true },
      '/health': { target: apiTarget(), changeOrigin: true },
    },
  },
})
