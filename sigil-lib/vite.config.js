import { defineConfig } from 'vite';

export default defineConfig({
  // Standalone viewer/harness dev server.
  // Port 5174 so it can run alongside the game frontend (:5173).
  server: {
    host: '0.0.0.0', // LAN-accessible
    port: 5174,
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
  },
});
