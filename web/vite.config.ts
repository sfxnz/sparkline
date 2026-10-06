/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.SPARKLINE_URL ?? 'http://127.0.0.1:9700';
// Keep the browser's Host header (no changeOrigin): the console rejects requests whose Origin does not match Host.
const proxy = { '/api': { target, ws: true } };

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: true, proxy },
  preview: { port: 5180, strictPort: true, proxy },
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: { include: [/tokens\.css/] },
  },
});
