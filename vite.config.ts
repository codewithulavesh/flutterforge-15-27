import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { ServerResponse } from 'node:http';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Any VITE_* provider key is inlined into the public client bundle by design
  // (Vite statically replaces import.meta.env.*). Warn loudly at build time so a
  // production/CI build never silently ships a live key. Rotate any key that
  // appears in built assets.
  for (const name of Object.keys(env)) {
    if (/^VITE_(OPENROUTER|DEEPSEEK|OPENAI|ANTHROPIC)/.test(name) && env[name]?.trim()) {
      console.warn(`\n⚠️  ${name} is set — it will be embedded in the public client bundle and visible to every user. Use server-side secrets (.env.local without the VITE_ prefix) for anything private.\n`);
    }
  }
  return {
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      // Local DeepSeek Harness engine (npm run server / Electron main).
      '/api': {
        target: process.env.VITE_HARNESS_DEV_URL || 'http://127.0.0.1:8787',
        changeOrigin: true,
        // A dead bridge must yield a JSON error, not an empty body — the UI
        // parses JSON and would otherwise show "Unexpected end of JSON input".
        configure: (proxy) => {
          proxy.on('error', (_error, _req, res) => {
            if (res instanceof ServerResponse && !res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
            }
            res.end(JSON.stringify({ error: 'Local harness engine is offline. Start it with: npm run server' }));
          });
        },
      },
      '/health': {
        target: process.env.VITE_HARNESS_DEV_URL || 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      // Embedded Flutter web preview compiler + static build output.
      '/preview': {
        target: process.env.VITE_HARNESS_DEV_URL || 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      // One-click publish web host.
      '/publish': {
        target: process.env.VITE_HARNESS_DEV_URL || 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  };
});
