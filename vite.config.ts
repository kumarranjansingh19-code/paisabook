import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Set BASE_PATH=/repo-name/ when deploying to GitHub Pages project sites.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  build: { target: 'es2022', sourcemap: false },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: 'PaisaBook',
        short_name: 'PaisaBook',
        description: 'Your bank alerts and statements, in a Google Sheet you own.',
        theme_color: '#0f766e',
        background_color: '#f8fafc',
        display: 'standalone',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Google APIs are never cached — always live.
        navigateFallbackDenylist: [/^\/oauth/],
      },
    }),
  ],
  test: { environment: 'node' },
});
