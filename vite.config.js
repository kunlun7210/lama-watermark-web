import { defineConfig } from 'vite'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 构建版本：每次 build 变化。写入 dist/version.json 并注入 JS，
// 页面启动时比对两者，不一致就自动刷新一次（拿到新 HTML/JS），
// 避免端上「旧 HTML + 新 JS」的缓存混合态；Cache Storage 里的模型缓存不受刷新影响。
const APP_VERSION = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
const APP_SEMVER = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
const now = new Date()
const BUILD_DATE = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`

function versionPlugin() {
  let outDir = 'dist'
  return {
    name: 'app-version',
    configResolved(resolved) { outDir = resolved.build.outDir },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        // 入口文件名保持稳定，查询参数负责区分构建。旧 HTML 即使仍在浏览器/CDN
        // 缓存中，也不会再引用一个部署后已经被删除的哈希文件。
        return html.replace(/(\.\/assets\/app\.(?:js|css))(?=["'])/g, `$1?v=${APP_VERSION}`)
      },
    },
    closeBundle() {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, 'version.json'), JSON.stringify({ version: APP_VERSION }))
    },
  }
}

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __APP_SEMVER__: JSON.stringify(APP_SEMVER),
    __BUILD_DATE__: JSON.stringify(BUILD_DATE),
  },
  plugins: [versionPlugin()],
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/app[extname]',
      },
    },
  },
  resolve: {
    // ORT 的默认入口里含 `new URL("ort-wasm-simd-threaded.wasm", import.meta.url)`，
    // Vite 见到就会把 13MB 的 wasm 复制进 dist/assets —— 而我们运行时用的是
    // public/ort/ 那一份（由 ort.env.wasm.wasmPaths 指向），于是产物里躺着两份同样的
    // 13MB wasm，白白多出 13MB 发布体积（评价第 11 条）。
    // 切到 ORT 官方的「外部 wasm」入口即可：该变体不含任何 wasm URL 引用。
    // 必须把 Vite 的默认条件一并列出 —— 这个字段是覆盖而非追加，漏掉会破坏其它依赖的解析。
    conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production'],
  },
  server: {
    // 保留仓库 1 既有的 WorkBuddy / CloudStudio 备份预览兼容性。
    allowedHosts: ['.trycloudflare.com', '.workbuddy.host', '.cloudstudio.club'],
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    allowedHosts: ['.trycloudflare.com', '.workbuddy.host', '.cloudstudio.club'],
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
