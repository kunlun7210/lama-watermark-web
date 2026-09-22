import { readFile, writeFile } from 'node:fs/promises'

const port = Number(process.env.CDP_PORT || 9223)
const targetPrefix = process.env.TEST_URL_PREFIX || 'http://localhost:5173'
const screenshotPath = process.env.SCREENSHOT_PATH || '/private/tmp/lama-iphone17.png'
const { version: expectedSemver } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const escapedSemver = expectedSemver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const versionPattern = new RegExp(`^v${escapedSemver} · \\d{4}\\.\\d{2}\\.\\d{2}$`)
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = targets.find(item => item.type === 'page' && item.url.startsWith(targetPrefix))
if (!target) throw new Error(`No page found for ${targetPrefix}`)

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let nextId = 1
const pending = new Map()
const browserErrors = []
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  } else if (message.method === 'Runtime.exceptionThrown') {
    browserErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
  }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function waitForIsolated({ requireNewDocument = false, timeoutMs = 60000 } = {}) {
  const started = Date.now()
  let recoveryReloaded = false
  while (Date.now() - started < timeoutMs) {
    let state = null
    try {
      state = await evaluate(`(() => ({
        ready: document.readyState,
        isolated: crossOriginIsolated,
        controlled: !!navigator.serviceWorker?.controller,
        oldDocument: window.__lamaBeforeReload === true,
      }))()`)
    } catch { /* service worker 接管或刷新时执行上下文会暂时失效 */ }
    if (state?.ready === 'complete' && state.isolated && (!requireNewDocument || !state.oldDocument)) return true
    // CDP 的强制 Page.reload 偶尔会生成一个已受 SW 控制、却未带 COOP/COEP 的文档。
    // 用页面自己的 reload 恢复一次；真实 Safari 刷新走的也是这条浏览器路径。
    if (state?.ready === 'complete' && state.controlled && !state.isolated && !recoveryReloaded) {
      recoveryReloaded = true
      try { await evaluate(`location.reload(); true`) } catch { /* 导航会中断当前调用 */ }
    }
    await sleep(250)
  }
  return false
}

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 402,
  height: 874,
  deviceScaleFactor: 3,
  mobile: true,
  screenWidth: 402,
  screenHeight: 874,
})
await send('Emulation.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
})

// GitHub Pages 首次打开要先由 coi-serviceworker 接管并自动重载。等这一步完成后
// 再注入旧线程偏好并做测试自己的重载，避免两个导航互相覆盖造成假超时。
const initiallyIsolated = await waitForIsolated()
if (!initiallyIsolated) throw new Error('Page did not become cross-origin isolated')

// 模拟旧版曾永久写入 1 线程；新版启动后必须主动清除。
await evaluate(`window.__lamaBeforeReload = true; localStorage.setItem('lama-threads', '1'); true`)
try { await evaluate(`location.reload(); true`) } catch { /* 导航会中断当前调用 */ }
const reloaded = await waitForIsolated({ requireNewDocument: true })
if (!reloaded) throw new Error('Page did not finish an isolated reload')
await sleep(1000)
await evaluate(`(async () => {
  const clear = document.querySelector('#clear')
  if (clear && !clear.hidden && document.querySelector('#stop')?.hidden) clear.click()
  for (let attempt = 0; attempt < 100 && document.querySelectorAll('#queue > li').length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return true
})()`)

const result = await evaluate(`(() => {
  const shell = document.querySelector('.shell')
  const preview = document.querySelector('#preview-grid')
  return {
    viewport: [innerWidth, innerHeight, devicePixelRatio],
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    iosLiquidGlass: document.documentElement.classList.contains('ios-liquid-glass'),
    version: document.querySelector('#app-version')?.textContent || '',
    productTitle: document.querySelector('h1')?.textContent || '',
    documentTitle: document.title,
    homeScreenTitle: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content || '',
    header: document.querySelector('header p')?.textContent || '',
    footer: document.querySelector('.footnote')?.innerText || '',
    resultTitle: document.querySelector('#result')?.closest('figure')?.querySelector('figcaption')?.textContent || '',
    shellPaddingTop: getComputedStyle(shell).paddingTop,
    eyebrowFontSize: getComputedStyle(document.querySelector('.eyebrow')).fontSize,
    modelDetailsOpen: document.querySelector('.model-more')?.open,
    metricsChildren: document.querySelector('#metrics')?.children.length,
    previewEmpty: preview?.dataset.empty,
    canvasesHidden: [...preview.querySelectorAll('canvas')].every(canvas => getComputedStyle(canvas).display === 'none'),
    oldCopyPresent: document.body.innerText.includes('LaMa-ONNX 结果') || document.body.innerText.includes('Gemini 专用还原暂未移植'),
    legacyThreadCap: localStorage.getItem('lama-threads'),
  }
})()`)

const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
console.log(JSON.stringify({ ...result, browserErrors, screenshotPath }, null, 2))
socket.close()

const valid = result.viewport[0] === 402
  && result.iosLiquidGlass
  && versionPattern.test(result.version)
  && result.productTitle === 'Xiaolin 去水印'
  && result.documentTitle === 'Xiaolin 去水印'
  && result.homeScreenTitle === 'Xiaolin 去水印'
  && result.header.includes('Gemini')
  && result.footer.includes('Gemini 会优先使用专用还原')
  && result.resultTitle === '处理结果'
  && result.shellPaddingTop === '86.5px'
  && result.eyebrowFontSize === '13px'
  && result.modelDetailsOpen === false
  && result.metricsChildren === 0
  && result.previewEmpty === 'true'
  && result.canvasesHidden
  && !result.oldCopyPresent
  && result.legacyThreadCap === null
  && browserErrors.length === 0
if (!valid) throw new Error('iPhone 17 Pro UI regression failed')
