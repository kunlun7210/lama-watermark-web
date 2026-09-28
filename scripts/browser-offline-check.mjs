import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'

const base = process.env.TEST_URL_PREFIX || 'http://127.0.0.1:4173'
const browserEngine = process.env.BROWSER_ENGINE === 'webkit' ? webkit : chromium
const browser = await browserEngine.launch(browserEngine === webkit ? { headless: true } : {
  headless: true,
  executablePath: process.env.CHROME_PATH || 'google-chrome',
  args: ['--no-sandbox'],
})

async function beginLayoutSampling(page) {
  await page.evaluate(() => {
    clearInterval(window.__cacheLayoutTimer)
    window.__cacheLayoutSamples = []
    const sample = () => {
      const controls = document.querySelector('.controls')?.getBoundingClientRect()
      const run = document.querySelector('#run-batch')?.getBoundingClientRect()
      const preview = document.querySelector('#preview-grid')?.getBoundingClientRect()
      window.__cacheLayoutSamples.push({
        controlsTop: controls?.top,
        runTop: run?.top,
        previewTop: preview?.top,
        scrollY,
      })
    }
    sample()
    window.__cacheLayoutTimer = setInterval(sample, 16)
  })
}

async function endLayoutSampling(page, label) {
  const samples = await page.evaluate(() => {
    clearInterval(window.__cacheLayoutTimer)
    return window.__cacheLayoutSamples || []
  })
  assert.ok(samples.length >= 2, `${label} 布局样本不足`)
  const spreads = {}
  for (const key of ['controlsTop', 'runTop', 'previewTop', 'scrollY']) {
    const values = samples.map(sample => sample[key]).filter(Number.isFinite)
    const spread = Math.max(...values) - Math.min(...values)
    spreads[key] = spread
    assert.ok(spread <= 1, `${label} ${key} 跳动 ${spread}px`)
  }
  console.log(`${label}：${samples.length} 帧，最大正文位移 ${Math.max(...Object.values(spreads))}px`)
}

try {
  const context = await browser.newContext({
    viewport: { width: 402, height: 874 },
    screen: { width: 402, height: 874 },
    deviceScaleFactor: 3,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
  })
  const page = await context.newPage()
  const errors = []
  const networkUrls = []
  let mainFrameNavigations = 0
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => networkUrls.push(request.url()))
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) mainFrameNavigations++ })
  await page.goto(`${base}/?source=origin`, { waitUntil: 'load' })
  await page.waitForFunction(() => crossOriginIsolated
    && navigator.serviceWorker.controller?.scriptURL.includes('/offline-service-worker.js'),
  null, { timeout: 60000 })
  await page.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.querySelector('#app-version')?.textContent || ''),
    null, { timeout: 10000 })
  await page.waitForTimeout(250)
  assert.ok(mainFrameNavigations >= 1 && mainFrameNavigations <= 2,
    `首次打开发生了 ${mainFrameNavigations} 次主文档导航`)
  assert.equal(await page.locator('html').evaluate(node => node.classList.contains('sw-booting')), false)

  await page.locator('.model-more summary').click()
  assert.match(await page.locator('.model-picker').innerText(), /FP32 · 198MB/)
  const circleStyles = await page.locator('.model-picker .model-choice-circle').evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node)
    return {
      width: style.width,
      height: style.height,
      borderWidth: style.borderWidth,
      borderRadius: style.borderRadius,
      appearance: style.appearance,
    }
  }))
  assert.equal(circleStyles.length, 3)
  assert.deepEqual([...new Set(circleStyles.map(style => JSON.stringify(style)))].length, 1,
    `三个模型圆点样式不一致：${JSON.stringify(circleStyles)}`)
  assert.equal(await page.locator('.status-card').count(), 0)
  assert.equal(await page.locator('.status-announcer').count(), 1)
  assert.equal(await page.locator('#download-bar').count(), 0, '页面不应存在下载浮窗')
  await page.waitForFunction(() => ['未缓存', '未确认'].includes(
    document.querySelector('#cache-tag-int8')?.textContent || ''), null, { timeout: 5000 })
  assert.equal(await page.locator('#file-input').isDisabled(), false)

  await beginLayoutSampling(page)
  await page.locator('#cache-ocr').click()
  await page.waitForFunction(() => [...document.querySelectorAll('input[name="model"]')]
    .every(input => input.disabled))
  assert.equal(await page.locator('#file-input').isDisabled(), false, '缓存 OCR 时仍应可以选择图片')
  assert.equal(await page.locator('#download-bar').count(), 0)
  await page.waitForFunction(() => document.querySelector('#cache-tag-ocr')?.textContent === '已缓存',
    null, { timeout: 60000 })
  await endLayoutSampling(page, 'OCR 首次缓存')
  assert.equal(await page.locator('input[name="model"]:disabled').count(), 0)
  assert.equal(await page.locator('#cache-ocr').isDisabled(), true)
  assert.equal(await page.locator('#ocr-model-hint').textContent(), '文字识别按需自动使用。')
  assert.equal(await page.locator('#cache-tag-ocr').getAttribute('class'), 'model-cache-tag cached')
  const selectedBackgrounds = await page.locator('input[name="model"]:checked, #cache-ocr.cached .model-choice-circle')
    .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundImage))
  assert.equal(selectedBackgrounds.length, 2)
  assert.equal(selectedBackgrounds[0], selectedBackgrounds[1])
  const portraitLayout = await page.evaluate(() => ({
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
    pickerOverflow: document.querySelector('.model-picker').scrollWidth
      - document.querySelector('.model-picker').clientWidth,
  }))
  assert.ok(portraitLayout.pageOverflow <= 0, JSON.stringify(portraitLayout))
  assert.ok(portraitLayout.pickerOverflow <= 0, JSON.stringify(portraitLayout))
  if (process.env.MODEL_UI_SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.MODEL_UI_SCREENSHOT_PATH, fullPage: true })
  }

  await page.setViewportSize({ width: 844, height: 390 })
  const landscapeLayout = await page.evaluate(() => ({
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
    pickerOverflow: document.querySelector('.model-picker').scrollWidth
      - document.querySelector('.model-picker').clientWidth,
  }))
  assert.ok(landscapeLayout.pageOverflow <= 0, JSON.stringify(landscapeLayout))
  assert.ok(landscapeLayout.pickerOverflow <= 0, JSON.stringify(landscapeLayout))

  await page.setViewportSize({ width: 402, height: 874 })
  await beginLayoutSampling(page)
  await page.locator('input[name="model"][value="int8"]').click()
  await page.waitForFunction(() => [...document.querySelectorAll('input[name="model"]')]
    .every(input => input.disabled) && document.querySelector('#cache-ocr')?.disabled)
  assert.equal(await page.locator('#file-input').isDisabled(), false, '缓存 LaMa 时仍应可以选择图片')
  await page.waitForFunction(() => document.querySelector('#cache-tag-int8')?.textContent === '已缓存'
    && !document.querySelector('input[name="model"][value="int8"]')?.disabled,
  null, { timeout: 120000 })
  await endLayoutSampling(page, 'LaMa 首次缓存')
  assert.equal(await page.locator('input[name="model"]:disabled').count(), 0)
  assert.equal(await page.locator('#download-bar').count(), 0)
  const requestsBeforeCachedClick = networkUrls.length
  await page.locator('input[name="model"][value="int8"]').click()
  await page.waitForTimeout(300)
  const repeatedDownloads = networkUrls.slice(requestsBeforeCachedClick)
    .filter(url => /\/models\/.*\.bin$|\/ocr\/.*\.tar$|\/ort\/.*\.(?:wasm|mjs)$|\/worker-entry-.*\.js$/.test(new URL(url).pathname))
  assert.deepEqual(repeatedDownloads, [], '已缓存模型被重复下载')
  assert.match(await page.locator('#status').textContent(), /已缓存/)

  // 精确复现真机问题：模型分段仍在，但当前构建的运行文件缺失。
  // 刷新后只能读缓存并标记“不完整”，不能在“检查中”偷偷联网补下载。
  const missingRuntime = await page.evaluate(async () => {
    const manifestUrl = new URL('offline-runtime.json', document.baseURI).href
    const response = await caches.match(manifestUrl, { ignoreSearch: true })
    const manifest = await response.json()
    const cache = await caches.open(`lama-shell-${manifest.build}`)
    const urls = [...manifest.lama, ...manifest.ocr].map(file => new URL(file, document.baseURI).href)
    await Promise.all(urls.map(url => cache.delete(url)))
    return urls
  })
  const requestsBeforeIncompleteReload = networkUrls.length
  const reloadStarted = Date.now()
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelector('#cache-tag-int8')?.textContent === '缓存不完整'
    && document.querySelector('#cache-tag-ocr')?.textContent === '缓存不完整',
  null, { timeout: 7000 })
  const incompleteCheckMs = Date.now() - reloadStarted
  assert.ok(incompleteCheckMs < 7000, `缓存状态检查耗时过长：${incompleteCheckMs}ms`)
  const unexpectedDownloads = networkUrls.slice(requestsBeforeIncompleteReload)
    .filter(url => missingRuntime.includes(url)
      || /\/models\/.*\.bin$|\/ocr\/.*\.tar$/.test(new URL(url).pathname))
  assert.deepEqual(unexpectedDownloads, [], `页面打开时发生了自动下载：${unexpectedDownloads.join(', ')}`)
  assert.equal(await page.locator('#download-bar').count(), 0)
  assert.equal(await page.locator('#file-input').isDisabled(), false)
  assert.equal(await page.locator('input[name="model"][value="int8"]').isDisabled(), false)
  assert.equal(await page.locator('#cache-ocr').isDisabled(), false)
  console.log(`运行文件缺失启动检查：${incompleteCheckMs}ms，无自动下载、无浮窗`)

  // 只有用户主动点选时才补齐相应运行文件。
  await page.locator('.model-more summary').click()
  await page.locator('#cache-ocr').click()
  await page.waitForFunction(() => document.querySelector('#cache-tag-ocr')?.textContent === '已缓存',
    null, { timeout: 60000 })
  await page.locator('input[name="model"][value="int8"]').click()
  await page.waitForFunction(() => document.querySelector('#cache-tag-int8')?.textContent === '已缓存',
    null, { timeout: 120000 })

  // Playwright WebKit 在 macOS 上对“setOffline 后直接 reload + Service Worker”会抛内部错误；
  // WebKit 先在线重开验证持久缓存，再断网读取同一套 SW 资源。Chromium 保留完整断网导航。
  if (browserEngine === webkit) {
    await page.reload({ waitUntil: 'load' })
    await page.waitForFunction(() => document.querySelector('#cache-tag-int8')?.textContent === '已缓存'
      && document.querySelector('#cache-tag-ocr')?.textContent === '已缓存',
    null, { timeout: 30000 })
    await context.setOffline(true)
  } else {
    await context.setOffline(true)
    await page.reload({ waitUntil: 'load' })
  }
  await page.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.querySelector('#app-version')?.textContent || ''),
    null, { timeout: 30000 })
  await page.waitForFunction(() => document.querySelector('#cache-tag-int8')?.textContent === '已缓存'
    && document.querySelector('#cache-tag-ocr')?.textContent === '已缓存',
  null, { timeout: 30000 })
  const offline = await page.evaluate(async ({ cacheOnly }) => {
    const files = ['templates/doubao_logo_mask.png', 'templates/xiaohongshu_label.png',
      'models/int8/manifest.json', 'models/fp32/manifest.json', 'offline-runtime.json']
    const responses = await Promise.all(files.map(async file => {
      const response = cacheOnly
        ? await caches.match(new URL(file, document.baseURI).href, { ignoreSearch: true })
        : await fetch(file)
      return [file, !!response?.ok]
    }))
    return { version: document.querySelector('#app-version').textContent,
      isolated: crossOriginIsolated,
      lamaTag: document.querySelector('#cache-tag-int8')?.textContent,
      ocrTag: document.querySelector('#cache-tag-ocr')?.textContent,
      ocrHint: document.querySelector('#ocr-model-hint')?.textContent,
      responses }
  }, { cacheOnly: browserEngine === webkit })
  assert.equal(offline.isolated, true)
  assert.equal(offline.lamaTag, '已缓存')
  assert.equal(offline.ocrTag, '已缓存')
  assert.equal(offline.ocrHint, '文字识别按需自动使用。')
  assert.ok(offline.responses.every(([, ok]) => ok), JSON.stringify(offline.responses))
  assert.deepEqual(errors, [])
  console.log('offline shell, platform templates, model manifests, and model option UI verified', offline.version)
  await context.close()

  // 即使 Safari 的 Cache Storage 自身异常变慢，也不能让页面停在“检查中”或禁用选图。
  const slowContext = await browser.newContext({
    viewport: { width: 402, height: 874 },
    screen: { width: 402, height: 874 },
    deviceScaleFactor: 3,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
  })
  await slowContext.addInitScript(() => {
    const originalMatch = Cache.prototype.match
    Cache.prototype.match = function (request, options) {
      const url = typeof request === 'string' ? request : request?.url || ''
      if (/\/models\/(?:int8|fp32)\/manifest\.json$|\/ocr\/.*\.tar$/.test(new URL(url, location.href).pathname)) {
        return new Promise(() => {})
      }
      return originalMatch.call(this, request, options)
    }
  })
  const slowPage = await slowContext.newPage()
  await slowPage.goto(`${base}/?source=origin`, { waitUntil: 'load' })
  await slowPage.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(
    document.querySelector('#app-version')?.textContent || ''), null, { timeout: 60000 })
  assert.equal(await slowPage.locator('#file-input').isDisabled(), false)
  assert.equal(await slowPage.locator('#download-bar').count(), 0)
  await slowPage.waitForFunction(() => document.querySelector('#cache-tag-int8')?.textContent === '未确认'
    && document.querySelector('#cache-tag-fp32')?.textContent === '未确认'
    && document.querySelector('#cache-tag-ocr')?.textContent === '未确认',
  null, { timeout: 5000 })
  console.log('Cache Storage 超时降级：页面可操作，2.5 秒后显示“未确认”')
  await slowContext.close()
} finally {
  await browser.close()
}
