import { defineConfig } from 'vite';

// Vite config. We import @chenglou/pretext directly; the worker plugin
// (vite-pretext) declares peer-vite ^8 which doesn't exist yet — we'll
// add it once it catches up. For now pretext runs sync on the main thread.
// 1,776 notes prepare in <100ms (demo benchmarks), so v0 is fine.
export default defineConfig({
  server: {
    port: 5173,
    // /api/* will 404 here — src/lib/api.ts falls back to sample data.
    // Use `npm run dev:cf` for the real API (wrangler pages dev + D1).
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
