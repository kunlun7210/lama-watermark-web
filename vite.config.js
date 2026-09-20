import { defineConfig } from 'vite'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 构建版本：每次 build 变化。写入 dist/version.json 并注入 JS，
// 页面启动时比对两者，不一致就自动刷新一次（拿到新 HTML/JS），
// 避免端上「旧 HTML + 新 JS」的缓存混合态；Cache Storage 里的模型缓存不受刷新影响。
const APP_VERSION = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)

// 界面上展示给用户的版本号与日期。
// 语义版本以 package.json 为唯一真相源 —— 避免「改了代码忘了改页面上的版本号」。
const APP_SEMVER = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
// 用本地日期而不是 UTC：用户在北京时间后半夜构建时，UTC 会退回前一天，显示出来就错了。
const now = new Date()
const BUILD_DATE = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`

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
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __APP_SEMVER__: JSON.stringify(APP_SEMVER),
    __BUILD_DATE__: JSON.stringify(BUILD_DATE),
  },
  plugins: [versionPlugin()],
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
    // allowedHosts 是开发/预览服务器对 Host 头的白名单校验（防 DNS rebinding）。
    // 用「点开头」的通配子域而不是 true：保持校验开启，只放行确实需要的域名。
    // ⚠️ 托管平台（WorkBuddy/CloudStudio 沙箱）转发过来的 Host 是**内部沙箱域名**
    //    （形如 3000-<sandboxId>.e2b.<region>.sandbox.cloudstudio.club），不是对外那个
    //    lama-watermark.app.workbuddy.host。只放行后者会被拦成
    //    403 "Blocked request. This host ... is not allowed."（页面白屏、连 HTML 都拿不到）。
    allowedHosts: ['.trycloudflare.com', '.workbuddy.host', '.cloudstudio.club'],
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    // 同上：托管平台用 `vite preview` 提供构建产物
    allowedHosts: ['.trycloudflare.com', '.workbuddy.host', '.cloudstudio.club'],
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
