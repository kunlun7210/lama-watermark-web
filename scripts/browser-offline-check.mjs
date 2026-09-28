import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.TEST_URL_PREFIX || 'http://127.0.0.1:4173'
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || 'google-chrome',
  args: ['--no-sandbox'],
})
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
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => crossOriginIsolated
    && navigator.serviceWorker.controller?.scriptURL.includes('/offline-service-worker.js'),
  null, { timeout: 60000 })

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

  await page.locator('#cache-ocr').click()
  await page.waitForFunction(() => document.querySelector('#cache-tag-ocr')?.textContent === '已缓存',
    null, { timeout: 60000 })
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

  await context.setOffline(true)
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.querySelector('#app-version')?.textContent || ''),
    null, { timeout: 30000 })
  const offline = await page.evaluate(async () => {
    const files = ['templates/doubao_logo_mask.png', 'templates/xiaohongshu_label.png',
      'models/int8/manifest.json', 'models/fp32/manifest.json', 'offline-runtime.json']
    const responses = await Promise.all(files.map(async file => [file, (await fetch(file)).ok]))
    return { version: document.querySelector('#app-version').textContent,
      isolated: crossOriginIsolated,
      ocrTag: document.querySelector('#cache-tag-ocr')?.textContent,
      ocrHint: document.querySelector('#ocr-model-hint')?.textContent,
      responses }
  })
  assert.equal(offline.isolated, true)
  assert.equal(offline.ocrTag, '已缓存')
  assert.equal(offline.ocrHint, '文字识别按需自动使用。')
  assert.ok(offline.responses.every(([, ok]) => ok), JSON.stringify(offline.responses))
  assert.deepEqual(errors, [])
  console.log('offline shell, platform templates, model manifests, and model option UI verified', offline.version)
  await context.close()
} finally {
  await browser.close()
}
