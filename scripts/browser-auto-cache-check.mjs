import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'

const sample = process.argv[2]
if (!sample) throw new Error('Usage: node scripts/browser-auto-cache-check.mjs /absolute/watermarked-image')
const isWebkit = process.env.BROWSER_ENGINE === 'webkit'
const browser = await (isWebkit ? webkit : chromium).launch(isWebkit ? {} : { channel: 'chrome' })
const base = process.env.TEST_URL_PREFIX || 'http://127.0.0.1:4180'
try {
  const context = await browser.newContext({ viewport: { width: 402, height: 874 } })
  const page = await context.newPage()
  const errors = []
  const chunks = []
  const ocrRequests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (/lama\.part\./.test(request.url())) chunks.push(request.url()) })
  page.on('request', request => { if (/\/ocr\/.*\.tar/.test(request.url())) ocrRequests.push(request.url()) })
  await page.goto(`${base}/?source=origin`)
  await page.waitForFunction(() => crossOriginIsolated && document.querySelector('#app-version')?.textContent)
  assert.equal(await page.locator('#preview-grid').isVisible(), false)
  assert.equal(chunks.length, 0, '首次打开不得自动下载模型')
  await page.locator('.model-more summary').click()
  async function selectOcrName() {
    const title = page.locator('#cache-ocr strong')
    await title.scrollIntoViewIfNeeded()
    const box = await title.boundingBox()
    await page.mouse.move(box.x + 1, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 20 })
    await page.mouse.up()
    assert.match(await page.evaluate(() => getSelection().toString()), /PP.*OCRv6.*small/)
    await page.evaluate(() => getSelection().removeAllRanges())
  }
  await selectOcrName()
  assert.equal(ocrRequests.length, 0, '拖选 OCR 名称不得触发缓存')
  // 不点模型卡片，直接选图，复现用户的首次使用路径。
  await page.setInputFiles('#file-input', sample)
  await page.waitForFunction(() => document.querySelector('#preview-grid')?.dataset.empty === 'false')
  assert.equal(await page.locator('#preview-grid').isVisible(), true)
  await page.waitForFunction(() => document.querySelector('#cache-tag-int8')?.textContent === '已缓存'
    && document.querySelector('#cache-tag-ocr')?.textContent === '已缓存'
    && !document.querySelector('input[value="int8"]')?.disabled, null, { timeout: 180000 })
  assert.ok(chunks.length > 0, '需要真实冷缓存模型下载')
  assert.ok(ocrRequests.length > 0, '首次选图需要自动缓存 OCR')
  assert.equal(chunks.some(url => url.includes('/fp32/')), false, 'FP32 不得自动下载')
  await selectOcrName()
  assert.equal(await page.locator('#transfer-card').isVisible(), false)
  await page.locator('#clear').click()
  await page.waitForFunction(() => document.querySelector('#preview-grid')?.dataset.empty === 'true')
  assert.equal(await page.locator('#preview-grid').isVisible(), false)
  // WebKit 的自动化离线导航存在引擎限制，在线重载释放会话后再断网处理。
  if (isWebkit) await page.reload()
  await context.setOffline(true)
  if (!isWebkit) await page.reload()
  await page.waitForFunction(() => document.querySelector('#cache-tag-int8')?.textContent === '已缓存'
    && document.querySelector('#cache-tag-ocr')?.textContent === '已缓存')
  await page.setInputFiles('#file-input', sample)
  await page.locator('#run-batch').click()
  await page.waitForFunction(() => /批量处理完成/.test(document.querySelector('#status')?.textContent),
    null, { timeout: 180000 })
  assert.match(await page.locator('#queue .q-state').innerText(), /已去除/)
  assert.deepEqual(errors, [])
  console.log(`${isWebkit ? 'WebKit' : 'Chrome'}: 首次选图自动缓存 INT8/OCR、FP32 无下载、OCR 名称拖选、空预览隐藏、断网新会话真实去水印通过`)
} finally {
  await browser.close()
}
