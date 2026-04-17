import { createHash } from 'node:crypto'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'

function finalEntryHashPlugin(): Plugin {
  return {
    name: 'rustypaste-final-entry-hash',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const renamedEntries = new Map<string, string>()

      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || !output.isEntry || !output.fileName.endsWith('.js')) {
          continue
        }

        const finalHash = createHash('sha256').update(output.code).digest('base64url').slice(0, 8)
        const finalFileName = output.fileName.replace(/-[A-Za-z0-9_-]+(?=\.js$)/, `-${finalHash}`)

        if (finalFileName === output.fileName) {
          continue
        }

        renamedEntries.set(output.fileName, finalFileName)
        output.fileName = finalFileName
      }

      if (renamedEntries.size === 0) {
        return
      }

      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') {
          for (const [oldName, newName] of renamedEntries) {
            output.code = output.code.split(oldName).join(newName)
          }
        }

        if (output.type === 'asset' && typeof output.source === 'string') {
          for (const [oldName, newName] of renamedEntries) {
            output.source = output.source.split(oldName).join(newName)
          }
        }
      }
    },
  }
}

export default defineConfig({
  plugins: [vue(), cssInjectedByJsPlugin(), finalEntryHashPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/auth': { target: 'http://localhost:8001', changeOrigin: true },
      '/api': { target: 'http://localhost:8085', changeOrigin: true, rewrite: (path) => path.replace(/^\/api/, '') },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
