import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.TEST_URL_PREFIX || 'http://127.0.0.1:4173'
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || 'google-chrome',
  args: ['--no-sandbox'],
})
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => crossOriginIsolated
    && navigator.serviceWorker.controller?.scriptURL.includes('/offline-service-worker.js'),
  null, { timeout: 60000 })

  await page.locator('.model-more summary').click()
  assert.match(await page.locator('.model-picker').innerText(), /FP32 · 198MB/)
  assert.equal(await page.locator('.model-picker #cache-ocr .model-choice-circle').count(), 1)

  await context.setOffline(true)
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.querySelector('#app-version')?.textContent || ''),
    null, { timeout: 30000 })
  const offline = await page.evaluate(async () => {
    const files = ['templates/doubao_logo_mask.png', 'templates/xiaohongshu_label.png',
      'models/int8/manifest.json', 'models/fp32/manifest.json', 'offline-runtime.json']
    const responses = await Promise.all(files.map(async file => [file, (await fetch(file)).ok]))
    return { version: document.querySelector('#app-version').textContent,
      isolated: crossOriginIsolated, responses }
  })
  assert.equal(offline.isolated, true)
  assert.ok(offline.responses.every(([, ok]) => ok), JSON.stringify(offline.responses))
  assert.deepEqual(errors, [])
  console.log('offline shell, platform templates, model manifests, and model option UI verified', offline.version)
  await context.close()
} finally {
  await browser.close()
}
