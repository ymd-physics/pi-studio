import { cpSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/main/minimal/index.ts'), output: { format: 'es' } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/minimal.ts'), bubble: resolve('src/preload/bubble.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    publicDir: resolve('node_modules/.cache/pi-renderer-public'),
    plugins: [react(), { name:'offline-pdf-assets', configResolved() {
      const dest = resolve('node_modules/.cache/pi-renderer-public/pdf-assets')
      mkdirSync(dest,{recursive:true})
      for (const name of ['LICENSE','cmaps','standard_fonts','wasm','iccs']) cpSync(resolve('node_modules/pdfjs-dist',name),resolve(dest,name),{recursive:true})
    } }],
    build: { rollupOptions: { input: [resolve('src/renderer/index.html'), resolve('src/renderer/bubble.html')] } },
  },
})
