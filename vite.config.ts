import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    // GitHub Pages serves files without the SharedArrayBuffer headers required
    // by DuckDB-WASM's multi-threaded mode. This plugin injects the COOP/COEP
    // headers in the dev server; production is handled by _headers (see public/).
    {
      name: 'configure-response-headers',
      configureServer(server) {
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
          next()
        })
      },
    },
  ],
  optimizeDeps: {
    // DuckDB-WASM ships its own worker + WASM bundles; Vite must not try to
    // pre-bundle them or the dynamic worker URL will break.
    exclude: ['@duckdb/duckdb-wasm'],
  },
})
