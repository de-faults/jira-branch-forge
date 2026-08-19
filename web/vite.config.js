import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const API = `http://127.0.0.1:${process.env.PORT || 4178}`;

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  build: { outDir: path.resolve(import.meta.dirname, '../dist'), emptyOutDir: true },
  server: {
    host: '127.0.0.1', // never expose the dev server on the LAN
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: API, changeOrigin: false } },
  },
});
