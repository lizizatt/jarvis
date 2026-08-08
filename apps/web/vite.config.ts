import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Jarvis Developer Control',
        short_name: 'Jarvis',
        description: 'Private mobile control for local developer agents',
        theme_color: '#070909',
        background_color: '#070909',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }]
      },
      injectManifest: { globPatterns: ['**/*.{js,css,html,svg,woff2}'] }
    })
  ],
  server: { proxy: {
    '/api': 'http://127.0.0.1:3210',
    '/ws': { target: 'ws://127.0.0.1:3210', ws: true }
  } },
  test: { globals: true, environment: 'jsdom', setupFiles: './src/test/setup.ts', include: ['src/**/*.test.{ts,tsx}'], css: true }
});
