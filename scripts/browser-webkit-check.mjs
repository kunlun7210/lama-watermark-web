/**
 * 真 Safari 内核验证：用 Playwright 的 WebKit 引擎跑真实页面与真实处理。
 *
 * 为什么需要它：用 Chrome 模拟 iPhone 视口**不等于** Safari。这个应用依赖三项
 * Safari 上有真实差异的能力，而它们恰好都是命脉：
 *   1. 内联 Blob Worker —— 重活能不能搬出主线程
 *   2. SharedArrayBuffer —— ORT 多线程 WASM 的前提
 *   3. crossOriginIsolated —— 决定线程数是 4 还是 1（差异 2–4 倍，且是静默降级）
 * 只验 API 是否存在还不够，必须真的跑一遍业务。
 *
 * 前置：
 *   npm i -D playwright           # 已在 devDependencies 中
 *   npx playwright install webkit # 首次需下载引擎（约 78MB）
 *
 * 用法：
 *   node scripts/browser-webkit-check.mjs <url> [样张...]
 *   node scripts/browser-webkit-check.mjs https://example.com/ 一张.png 两张.png
 *
 * 样张参数可省略（只做环境诊断与加载检查）。
 */
import { webkit, devices } from 'playwright'

const url = process.argv[2] || process.env.TEST_URL
const samples = process.argv.slice(3)
if (!url) {
  console.error('用法：node scripts/browser-webkit-check.mjs <url> [样张...]')
  process.exit(2)
}

const browser = await webkit.launch()
const context = await browser.newContext({ ...devices['iPhone 15 Pro'] })
const page = await context.newPage()

// jsDelivr 在 COEP `require-corp` 下**必然**被拦（它不返回 CORP 头），
// 而应用的自动换源会立刻切到同源并正常工作 —— 这是预期内的噪音，不能算失败。
// 不把它挑出来，这个脚本每次都会误报红。
const KNOWN_NOISE = /cdn\.jsdelivr\.net[\s\S]*access control checks/i

const consoleErrors = []
const pageErrors = []
const knownNoise = []
page.on('console', message => {
  if (message.type() !== 'error') return
  const text = message.text().slice(0, 200)
  ;(KNOWN_NOISE.test(text) ? knownNoise : consoleErrors).push(text)
})
page.on('pageerror', error => {
  const text = String(error).slice(0, 200)
  ;(KNOWN_NOISE.test(text) ? knownNoise : pageErrors).push(text)
})

console.log(`=== 真 WebKit 验证（${url}）===`)
console.log('  引擎：', context.browser()?.version?.() ?? '(webkit)')

await page.goto(url, { waitUntil: 'load', timeout: 180000 })
// 补 COOP/COEP 的 Service Worker（GitHub Pages 这类不能自定义响应头的托管）
// 需要一次重载才生效，所以这里 reload 一次再看隔离状态。
await page.reload({ waitUntil: 'load', timeout: 180000 })
await page.waitForTimeout(2000)

const env = await page.evaluate(() => {
  const blobWorker = (() => {
    try {
      const blob = new Blob(['self.onmessage=()=>self.postMessage(1)'], { type: 'text/javascript' })
      const worker = new Worker(URL.createObjectURL(blob))
      worker.terminate()
      return 'ok'
    } catch (error) { return String(error) }
  })()
  return {
    isolated: crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    blobWorker,
    swControlled: !!navigator.serviceWorker?.controller,
    version: (document.querySelector('#app-version')?.textContent || '').trim(),
  }
})
console.log('  环境诊断：')
for (const [key, value] of Object.entries(env)) console.log(`    ${key.padEnd(20)} = ${value}`)

let processed = 0
let failed = 0
for (const sample of samples) {
  const started = Date.now()
  await page.evaluate(() => { const clear = document.querySelector('#clear'); if (clear && !clear.hidden) clear.click() })
  await page.waitForTimeout(1200)
  await page.setInputFiles('#file-input', sample)
  await page.waitForTimeout(1600)
  await page.click('#run-batch')
  try {
    await page.waitForFunction(
      () => /批量处理完成/.test(document.querySelector('#status')?.textContent || ''),
      { timeout: 300000 },
    )
    processed++
  } catch { failed++ }
  const state = await page.evaluate(() => (document.querySelector('#queue > li .q-state')?.textContent || '').trim())
  console.log(`  ${failed ? '✗' : '✓'} ${sample.split('/').pop().slice(0, 34).padEnd(36)} ${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s  ${state}`)
}

console.log('  控制台错误：', JSON.stringify(consoleErrors))
console.log('  页面异常  ：', JSON.stringify(pageErrors))
if (knownNoise.length) {
  console.log(`  已知噪音（不计失败）：${knownNoise.length} 条 —— jsDelivr 在 COEP 下被拦，应用已自动换源到同源`)
}
console.log(`  真实处理：成功 ${processed} / 失败 ${failed}`)

await browser.close()
const ok = failed === 0 && consoleErrors.length === 0 && pageErrors.length === 0
console.log(ok ? '\n✅ WebKit 验证通过' : '\n❌ WebKit 验证未通过')
process.exit(ok ? 0 : 1)
