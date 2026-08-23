import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'

export default defineConfig({
  plugins: [vue(), cssInjectedByJsPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/auth': { target: 'http://localhost:8085', changeOrigin: true },
      '/api': { target: 'http://localhost:8085', changeOrigin: true, rewrite: (path) => path.replace(/^\/api/, '') },
      // Keep the canonical public raw route direct in local development too.
      // Encrypted links include a "+" key suffix and remain handled by the SPA.
      '^/file/[^/+]+/raw$': { target: 'http://localhost:8085', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'oxc',
    cssMinify: 'lightningcss',
    sourcemap: false,
    reportCompressedSize: false,
  },
})
