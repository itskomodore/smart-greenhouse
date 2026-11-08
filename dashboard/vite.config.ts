import { defineConfig } from 'vite';

// Dev: `pnpm dev` serves on :5173 and proxies API + SSE to the edge service.
// Override with DASHBOARD_PROXY_TARGET=http://<edge-host>:8080 if the edge runs elsewhere.
const target = process.env.DASHBOARD_PROXY_TARGET ?? 'http://localhost:8080';

const proxy = {
  '/api': { target, changeOrigin: false, secure: false },
  '/healthz': { target, changeOrigin: false, secure: false },
};

export default defineConfig({
  root: import.meta.dirname,
  plugins: [],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 300,
  },
});
