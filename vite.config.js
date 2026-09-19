import { defineConfig } from 'vite'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// 构建版本：每次 build 变化。写入 dist/version.json 并注入 JS，
// 页面启动时比对两者，不一致就自动刷新一次（拿到新 HTML/JS），
// 避免端上「旧 HTML + 新 JS」的缓存混合态；Cache Storage 里的模型缓存不受刷新影响。
const APP_VERSION = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)

function versionPlugin() {
  let outDir = 'dist'
  return {
    name: 'app-version',
    configResolved(resolved) { outDir = resolved.build.outDir },
    closeBundle() {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, 'version.json'), JSON.stringify({ version: APP_VERSION }))
    },
  }
}

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [versionPlugin()],
  server: {
    allowedHosts: ['.trycloudflare.com'],
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
