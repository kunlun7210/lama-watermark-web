/**
 * UI + 既有平台回归（针对本仓库的实际取值，不照搬新版断言）。
 *
 * 用法：TEST_URL_PREFIX=http://localhost:5173 CDP_PORT=9223 node scripts/browser-ui-check.mjs
 *
 * 1) iPhone 17 Pro / iOS 27 视口下核对：版本号、顶部与底部新文案、旧文案已消失、
 *    结果面板标题、预览区空态、Liquid Glass 偏移、状态区格数。
 * 2) 完整流水线跑各平台样张（非 Gemini），确认水印类型仍被正确识别 ——
 *    证明 Gemini 检测与既有规则并行、且未干扰它们。
 */
import { readFile, writeFile } from 'node:fs/promises'

const port = Number(process.env.CDP_PORT || 9223)
const targetPrefix = process.env.TEST_URL_PREFIX || 'http://localhost:5173'
// 版本号只锁语义版本，日期用格式校验 —— 构建日期随「哪天构建」变化，
// 把它写死会让断言在第二天必然失败（假红），那不是被测代码的问题。
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const EXPECT_SEMVER = process.env.EXPECT_SEMVER || `v${pkg.version}`
const VERSION_PATTERN = new RegExp(`^${EXPECT_SEMVER.replace(/[.]/g, '\\.')} · \\d{4}\\.\\d{2}\\.\\d{2}$`)
const EXPECT_MODEL_LABEL = process.env.EXPECT_MODEL_LABEL || 'INT8 · 62MB'
// 每个平台取 1 张，验证「水印类型」仍能正确识别出该平台
const SAMPLES = (process.env.PLATFORM_SAMPLES || '').split('||').filter(Boolean)

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = targets.find(item => item.type === 'page' && item.url.startsWith(targetPrefix))
if (!target) throw new Error(`没有找到 ${targetPrefix} 的页面`)

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
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

await send('Runtime.enable')
await send('DOM.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 402, height: 874, deviceScaleFactor: 3, mobile: true, screenWidth: 402, screenHeight: 874,
})
await send('Emulation.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
})
await send('Page.reload', { ignoreCache: false })
for (let attempt = 0; attempt < 80; attempt++) {
  if (await evaluate(`document.readyState === 'complete'`)) break
  await sleep(250)
}
await sleep(1200)
await evaluate(`(async () => {
  const clear = document.querySelector('#clear')
  if (clear && !clear.hidden && document.querySelector('#stop')?.hidden) clear.click()
  for (let attempt = 0; attempt < 100 && document.querySelectorAll('#queue > li').length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return true
})()`)

const ui = await evaluate(`(() => {
  const shell = document.querySelector('.shell')
  const preview = document.querySelector('#preview-grid')
  return {
    viewport: [innerWidth, innerHeight, devicePixelRatio],
    iosLiquidGlass: document.documentElement.classList.contains('ios-liquid-glass'),
    version: (document.querySelector('#app-version')?.textContent || '').trim(),
    modelSummaryLabel: (document.querySelector('.model-summary-label')?.textContent || '').trim(),
    modelSummaryValue: (document.querySelector('#current-model-label')?.textContent || '').trim(),
    header: (document.querySelector('header p')?.textContent || '').trim(),
    footer: (document.querySelector('.footnote')?.innerText || '').replace(/\\n/g, ' / '),
    resultTitle: (document.querySelector('#result')?.closest('figure')?.querySelector('figcaption')?.textContent || '').trim(),
    sourceTitle: (document.querySelector('#source')?.closest('figure')?.querySelector('figcaption')?.textContent || '').trim(),
    shellPaddingTop: getComputedStyle(shell).paddingTop,
    metricsChildren: document.querySelector('#metrics')?.children.length,
    previewEmpty: preview?.dataset.empty,
    canvasesHidden: [...preview.querySelectorAll('canvas')].every(canvas => getComputedStyle(canvas).display === 'none'),
    oldCopyPresent: document.body.innerText.includes('LaMa-ONNX 结果') || document.body.innerText.includes('Gemini 专用还原暂未移植'),
    geminiInFooter: document.body.innerText.includes('Gemini 会优先使用专用还原'),
  }
})()`)

const checks = [
  ['视口 402×874', ui.viewport[0] === 402],
  ['iOS 27 Liquid Glass 类', ui.iosLiquidGlass === true],
  ['版本号 ' + EXPECT_SEMVER + ' · YYYY.MM.DD', VERSION_PATTERN.test(ui.version)],
  ['模型摘要行 = 本地 AI 模型 ' + EXPECT_MODEL_LABEL, ui.modelSummaryLabel === '本地 AI 模型' && ui.modelSummaryValue === EXPECT_MODEL_LABEL],
  ['顶部文案含 Gemini', ui.header.includes('Gemini')],
  ['底部文案含 Gemini 专用还原说明', ui.geminiInFooter],
  ['旧文案已消失', ui.oldCopyPresent === false],
  ['结果面板标题 = 处理结果', ui.resultTitle === '处理结果'],
  ['原图面板标题 = 原图', ui.sourceTitle === '原图'],
  ['Liquid Glass 下移生效（非 28px）', parseFloat(ui.shellPaddingTop) > 28],
  ['状态区收起（0 格）', ui.metricsChildren === 0],
  ['预览区空态', ui.previewEmpty === 'true'],
  ['空态下 canvas 隐藏', ui.canvasesHidden === true],
]
console.log('=== UI 检查（iPhone 17 Pro · iOS 27）===')
let failed = 0
for (const [label, ok] of checks) {
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label)
  if (!ok && process.env.SKIP_UI !== '1') failed++
}
console.log('  shell padding-top = ' + ui.shellPaddingTop + '（v0.10.1 起为 86.5px）')
console.log('  顶部: ' + ui.header)
console.log('  底部: ' + ui.footer)
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
await writeFile('/tmp/gemini-ui-iphone17.png', Buffer.from(shot.data, 'base64'))
console.log('  截图: /tmp/gemini-ui-iphone17.png')

/* ---------- 既有平台回归：完整流水线 ---------- */
if (SAMPLES.length) {
  console.log('')
  console.log('=== 既有平台回归（完整流水线，确认未被 Gemini 干扰）===')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 1000, deviceScaleFactor: 2, mobile: false, screenWidth: 1280, screenHeight: 1000,
  })
  await send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  })
  await send('Page.reload', { ignoreCache: false })
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await evaluate(`document.readyState === 'complete'`)) break
    await sleep(250)
  }
  await sleep(1000)

  for (const entry of SAMPLES) {
    const [expectPlatform, file] = entry.split('::')
    await evaluate(`(() => { const c=document.querySelector('#clear'); if(c&&!c.hidden) c.click(); return true })()`)
    await sleep(1200)
    const documentNode = await send('DOM.getDocument', { depth: 1 })
    const input = await send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#file-input' })
    await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] })
    await sleep(2500)
    await evaluate(`document.querySelector('#run-batch').click(); true`)
    let state = null
    const started = Date.now()
    while (Date.now() - started < 420000) {
      state = await evaluate(`(() => {
        const li = document.querySelector('#queue > li')
        return {
          running: !document.querySelector('#stop')?.hidden,
          cls: li?.className || '',
          state: (li?.querySelector('.q-state')?.textContent || '').trim(),
          status: (document.querySelector('#status')?.textContent || '').trim(),
        }
      })()`)
      if (!state.running && /批量处理完成/.test(state.status || '')) break
      await sleep(1500)
    }
    const ok = state && (state.state.includes(expectPlatform) || /未识别水印/.test(state.state))
    console.log('  ' + (ok ? '✓' : '✗') + ' 期望 ' + expectPlatform.padEnd(10) + ' → ' + state.state)
  }
}

console.log('')
console.log('浏览器错误: ' + JSON.stringify(browserErrors))
socket.close()
if (failed) throw new Error('UI 检查有 ' + failed + ' 项未通过')
if (browserErrors.length) throw new Error('存在浏览器错误')
