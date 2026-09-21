/**
 * 边界行为浏览器验证（针对稳定版 v0.17.x 的三项修复）。
 *
 * 用法：TEST_URL_PREFIX=http://127.0.0.1:4173 node scripts/browser-boundary-check.mjs
 *
 * 三组断言，全部**按行为验收**，不看代码下结论：
 *
 *  1) 「保持原图」必须保持原始字节
 *     浏览器现生成一张 128×128 无水印 JPEG → 记录长度与 SHA-256 →
 *     走完整处理流程（应判「未识别」）→ 从 IndexedDB 读回结果比对长度与 SHA-256 →
 *     再导出 ZIP，比对「原图」条目与输入逐字节一致、CRC 正确。
 *     ⚠️ 「视觉上看不出区别」不算通过。
 *
 *  2) 超限追加原子拒绝
 *     已有 1 张完成结果时追加 40 张 → 整批拒绝。
 *     面板出现指定文案、队列不变、IndexedDB 的 images/results 都不变、
 *     文件输入框被清空、没有启动模型预热。
 *
 *  3) 损坏首图不能清空整批
 *     第 1 张为零字节以外的**无法解码** JPEG、第 2 张有效无水印 JPEG →
 *     处理后 1 张失败 + 1 张有效 → 刷新后队列仍 2 张、结果仍 1 条，
 *     有效那张可预览/可下载/可进 ZIP，且页面不出现「浏览器清理了数据」。
 *
 * 模型请求全程拦截（本地 /models/、jsDelivr、HuggingFace、备用 Pages）：
 * 这组边界用例全是不需要推理的干净图，下载 62MB 模型毫无意义。
 */
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const base = process.argv[2] || process.env.TEST_URL_PREFIX || 'http://127.0.0.1:4173'
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')

let failed = 0
const checks = []
const check = (label, ok, extra = '') => {
  checks.push([label, ok, extra])
  if (!ok) failed++
}

/* ---------------- ZIP 解析（STORE 方法，内容即原始字节） ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value >>> 0
  }
  return table
})()
const crc32 = bytes => {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function readZipEntries(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const decoder = new TextDecoder()
  const entries = []
  let offset = 0
  while (offset + 30 <= buffer.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true)
    const declaredCrc = view.getUint32(offset + 14, true)
    const size = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const name = decoder.decode(buffer.subarray(offset + 30, offset + 30 + nameLength))
    const dataStart = offset + 30 + nameLength + extraLength
    const bytes = buffer.subarray(dataStart, dataStart + size)
    entries.push({ name, method, declaredCrc, bytes, crcOk: crc32(bytes) === declaredCrc })
    offset = dataStart + size
  }
  return entries
}

/* ---------------- 夹具 ---------------- */

// 损坏 JPEG：有正确的 SOI/APP0 头、长度非零，但没有 SOF/SOS、也没有 EOI。
// 特意不用「零字节文件」——零字节是新选择时会被直接丢弃的另一条路径，
// 这里要验的是「看起来像文件、其实解不开」这种更隐蔽的损坏。
const corruptJpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0', 'latin1'),
  Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  Buffer.from(Array.from({ length: 640 }, (_, index) => (index * 37) % 256)),
])

/* ---------------- 浏览器 ---------------- */

// CI 里由 workflow 传 CHROME_PATH（用探测到的系统 Chrome，免去再下一次浏览器）；
// 本地默认走 channel:'chrome'，与仓库其它浏览器脚本保持一致。
const browser = await chromium.launch(process.env.CHROME_PATH
  ? { executablePath: process.env.CHROME_PATH }
  : { channel: 'chrome' })
const context = await browser.newContext({
  viewport: { width: 1280, height: 1000 },
  deviceScaleFactor: 1,
  acceptDownloads: true,
})
const page = await context.newPage()

const pageErrors = []
page.on('pageerror', error => pageErrors.push(String(error)))
const modelHits = []
page.on('request', request => {
  const url = request.url()
  if (/\/models\/|cdn\.jsdelivr\.net|huggingface\.co/.test(url)) modelHits.push(url)
})

// 双保险拦截模型请求：
//  · page.route 负责「看得见」（计入 modelHits，能断言有没有被尝试）
//  · CDP setBlockedURLs 在网络层拦死（连 Service Worker 发起的请求也拦得住）
await page.route('**/*', route => {
  const url = route.request().url()
  if (/\/models\/|cdn\.jsdelivr\.net|huggingface\.co/.test(url)) return route.abort()
  return route.continue()
})
const cdp = await context.newCDPSession(page)
await cdp.send('Network.enable')
await cdp.send('Network.setBlockedURLs', {
  urls: ['*://*/models/*', '*cdn.jsdelivr.net*', '*huggingface.co*', '*lama-watermark.app.workbuddy.host*'],
})

const statusText = () => page.evaluate(() => (document.querySelector('#status')?.textContent || '').trim())
const selectedName = () => page.evaluate(() => (document.querySelector('#selected-name')?.textContent || '').trim())
const queueStates = () => page.evaluate(() => [...document.querySelectorAll('#queue > li')].map(row => ({
  name: (row.querySelector('.q-name')?.textContent || '').trim(),
  state: (row.querySelector('.q-state')?.textContent || '').trim(),
  hasActions: !!row.querySelector('.q-actions button, .q-actions a'),
})))

const waitForBatchEnd = async (timeout = 300000) => {
  try {
    await page.waitForFunction(() => /批量处理完成|已停止/.test(document.querySelector('#status')?.textContent || ''), { timeout })
  } catch {
    console.log(`  ⚠ 未在时限内结束，当前状态：${await statusText()}`)
  }
}

/** 清空上一批（走真实按钮，顺带验证它确实会删库） */
const clearList = async () => {
  await page.evaluate(() => { const button = document.querySelector('#clear'); if (button && !button.hidden) button.click() })
  await page.waitForTimeout(800)
}

/** 等模型请求安静下来：选图后应用会主动预热模型（既有行为），
 *  必须等这波重试彻底停息，之后的新请求才能算到「本次动作」头上。 */
const waitForQuietModels = async (quietMs = 3000, maxMs = 45000) => {
  const started = Date.now()
  let last = modelHits.length
  let quietSince = Date.now()
  while (Date.now() - started < maxMs) {
    await page.waitForTimeout(250)
    if (modelHits.length !== last) { last = modelHits.length; quietSince = Date.now() }
    if (Date.now() - quietSince >= quietMs) return true
  }
  return false
}

/** 读 IndexedDB：原图批次条数、结果条数，以及每条结果的长度与 SHA-256 */
const readDatabase = () => page.evaluate(async () => {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('lama-iphone-poc', 2)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('results')) db.createObjectStore('results', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const readAll = store => new Promise((resolve, reject) => {
    const request = database.transaction(store, 'readonly').objectStore(store).getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const digest = async blob => {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    return { size: bytes.byteLength, sha256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') }
  }
  const [images, results] = await Promise.all([readAll('images'), readAll('results')])
  database.close()
  const batch = images.find(record => record.id === 'batch')
  return {
    imageFiles: batch?.files?.length || 0,
    imageIds: batch?.ids?.length || 0,
    imageNames: (batch?.files || []).map(entry => entry.name),
    resultCount: results.length,
    results: await Promise.all(results.map(async record => ({
      id: record.id,
      status: record.status,
      outputExt: record.outputExt,
      ...(record.outputBlob ? { output: await digest(record.outputBlob) } : {}),
    }))),
  }
})

let generatedJpeg = null

try {
  await page.goto(base, { waitUntil: 'load', timeout: 180000 })
  await page.reload({ waitUntil: 'load', timeout: 180000 })
  await page.waitForTimeout(1500)
  await clearList()

  // 浏览器现场生成 128×128 无水印 JPEG：渐变 + 几个柔和的圆，不含任何平台水印特征
  generatedJpeg = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 128
    const context = canvas.getContext('2d')
    const gradient = context.createLinearGradient(0, 0, 128, 128)
    gradient.addColorStop(0, '#3f6d9e')
    gradient.addColorStop(0.5, '#8fb7c9')
    gradient.addColorStop(1, '#e8d9b8')
    context.fillStyle = gradient
    context.fillRect(0, 0, 128, 128)
    context.globalAlpha = 0.25
    context.fillStyle = '#ffffff'
    context.beginPath(); context.arc(38, 44, 22, 0, Math.PI * 2); context.fill()
    context.beginPath(); context.arc(92, 86, 28, 0, Math.PI * 2); context.fill()
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92))
    return [...new Uint8Array(await blob.arrayBuffer())]
  }))
  const cleanSha = sha256(generatedJpeg)
  console.log(`夹具：无水印 JPEG ${generatedJpeg.length} 字节 · sha256 ${cleanSha.slice(0, 16)}…`)

  /* ================= 一、「保持原图」的字节一致性 ================= */
  console.log('\n=== 一、「保持原图」必须保持原始字节 ===')
  await page.setInputFiles('#file-input', [{ name: 'boundary-clean.jpg', mimeType: 'image/jpeg', buffer: generatedJpeg }])
  await page.waitForTimeout(1200)
  await page.click('#run-batch')
  await waitForBatchEnd()

  const cleanQueue = await queueStates()
  check('无水印 JPEG 被判「未识别 · 保持原图」',
    cleanQueue.length === 1 && /未识别水印 · 保持原图/.test(cleanQueue[0].state), cleanQueue[0]?.state)
  // 未识别路径不建会话是由「处理没有被模型请求卡住」间接证明的：
  // 模型全程被拦，一旦要推理就会抛错变 failed，而这里顺利跑成了「未识别」。
  console.log(`  · 过程中的模型请求尝试 ${modelHits.length} 次（均为选图后的既有预热，已被拦截）`)

  const afterClean = await readDatabase()
  const cleanResult = afterClean.results[0]
  check('结果已写入 IndexedDB', afterClean.resultCount === 1 && !!cleanResult?.output)
  check('IndexedDB 里的结果与输入长度一致',
    cleanResult?.output?.size === generatedJpeg.length, `${cleanResult?.output?.size} vs ${generatedJpeg.length}`)
  check('IndexedDB 里的结果与输入 SHA-256 一致',
    cleanResult?.output?.sha256 === cleanSha,
    `${String(cleanResult?.output?.sha256).slice(0, 16)}… vs ${cleanSha.slice(0, 16)}…`)
  check('输出后缀保持原后缀 .jpg', cleanResult?.outputExt === '.jpg', String(cleanResult?.outputExt))

  const [zipDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.click('#save-all'),
  ])
  const singleZip = await readFile(await zipDownload.path())
  const singleEntries = readZipEntries(singleZip)
  const originalEntry = singleEntries.find(entry => entry.name.startsWith('原图-'))
  check('ZIP 中有「原图」条目', singleEntries.length === 1 && !!originalEntry, singleEntries.map(entry => entry.name).join(', '))
  check('ZIP 条目的 CRC 正确', originalEntry?.crcOk === true)
  check('ZIP「原图」条目与输入逐字节一致',
    !!originalEntry && originalEntry.bytes.length === generatedJpeg.length
      && sha256(originalEntry.bytes) === cleanSha)

  /* ================= 二、超限追加原子拒绝 ================= */
  console.log('\n=== 二、超限追加原子拒绝（1 张已完成 + 追加 40 张）===')
  const beforeAppend = await readDatabase()
  const quiet = await waitForQuietModels()
  check('追加前模型请求已停息（后续计数才算本次追加的）', quiet === true)
  const hitsBeforeAppend = modelHits.length
  const appendFiles = Array.from({ length: 40 }, (_, index) => ({
    name: `append-${String(index + 1).padStart(2, '0')}.jpg`,
    mimeType: 'image/jpeg',
    buffer: generatedJpeg,
  }))
  await page.setInputFiles('#file-input', appendFiles)
  await page.waitForTimeout(2500)

  const appendStatus = await statusText()
  const appendQueue = await queueStates()
  const afterAppend = await readDatabase()
  const inputFiles = await page.evaluate(() => document.querySelector('#file-input')?.files?.length ?? -1)
  const downloadBarHidden = await page.evaluate(() => !!document.querySelector('#download-bar')?.hidden)

  check('页面显示指定的拒绝文案',
    appendStatus === '无法追加：超过 40 张；现有 1 张及结果已保留', appendStatus)
  check('队列没有被追加（仍为 1 张）', appendQueue.length === 1)
  check('IndexedDB 原图批次未被改动',
    afterAppend.imageFiles === beforeAppend.imageFiles && afterAppend.imageIds === beforeAppend.imageIds
      && afterAppend.imageNames.join(',') === beforeAppend.imageNames.join(','),
    `${afterAppend.imageFiles} 张`)
  check('IndexedDB 结果未被改动（未被清空）',
    afterAppend.resultCount === beforeAppend.resultCount && afterAppend.resultCount === 1)
  check('文件输入框已清空（可再次触发 change）', inputFiles === 0, String(inputFiles))
  check('没有启动模型预热（无模型请求、无下载条）',
    modelHits.length === hitsBeforeAppend && downloadBarHidden,
    `模型请求 +${modelHits.length - hitsBeforeAppend}`)

  /* ================= 三、损坏首图不能清空整批 ================= */
  console.log('\n=== 三、损坏首图 + 有效次图 ===')
  await clearList()
  const undecodable = await page.evaluate(async bytes => {
    const file = new File([new Uint8Array(bytes)], 'probe.jpg', { type: 'image/jpeg' })
    try {
      const bitmap = await createImageBitmap(file)
      bitmap.close?.()
      return false
    } catch { return true }
  }, [...corruptJpeg])
  check('夹具确实无法解码（前置自检）', undecodable === true)

  await page.setInputFiles('#file-input', [
    { name: 'boundary-broken.jpg', mimeType: 'image/jpeg', buffer: corruptJpeg },
    { name: 'boundary-valid.jpg', mimeType: 'image/jpeg', buffer: generatedJpeg },
  ])
  await page.waitForTimeout(1500)
  await page.click('#run-batch')
  await waitForBatchEnd()

  const mixedQueue = await queueStates()
  check('两张都留在队列里', mixedQueue.length === 2, `${mixedQueue.length} 张`)
  check('第一张（损坏）单独失败，未连累第二张',
    /失败/.test(mixedQueue[0]?.state || '') && /未识别水印|已去除/.test(mixedQueue[1]?.state || ''),
    mixedQueue.map(row => row.state).join(' | '))

  const beforeRefresh = await readDatabase()
  check('IndexedDB 原图批次 = 2 条', beforeRefresh.imageFiles === 2, String(beforeRefresh.imageFiles))
  check('IndexedDB 结果 = 1 条（只有有效那张）', beforeRefresh.resultCount === 1, String(beforeRefresh.resultCount))

  await page.reload({ waitUntil: 'load', timeout: 180000 })
  await page.waitForTimeout(4000)
  const restoredQueue = await queueStates()
  const restoredDb = await readDatabase()
  const bodyText = await page.evaluate(() => document.body.innerText)

  check('刷新后队列仍为 2 张（坏图没有拖垮整批）', restoredQueue.length === 2, `${restoredQueue.length} 张`)
  check('刷新后有效那张的结果仍在', restoredQueue[1]?.state.includes('未识别水印') || restoredQueue[1]?.state.includes('已去除'), restoredQueue[1]?.state)
  check('刷新后 IndexedDB 原图批次仍为 2 条', restoredDb.imageFiles === 2, String(restoredDb.imageFiles))
  check('刷新后 IndexedDB 结果仍为 1 条', restoredDb.resultCount === 1, String(restoredDb.resultCount))
  check('页面没有出现「浏览器清理了数据」的说辞', !bodyText.includes('浏览器清理'), '')

  // 有效那张：可预览（点开画到 canvas）、可下载（有存图/下载入口）、可进 ZIP
  await page.evaluate(() => { const rows = document.querySelectorAll('#queue > li'); rows[rows.length - 1]?.click() })
  await page.waitForTimeout(1500)
  const preview = await page.evaluate(() => {
    const canvas = document.querySelector('#result')
    if (!canvas || !canvas.width) return { width: 0, painted: false }
    const data = canvas.getContext('2d').getImageData(0, 0, Math.min(canvas.width, 32), Math.min(canvas.height, 32)).data
    let painted = false
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) { painted = true; break }
    return { width: canvas.width, painted }
  })
  check('刷新后结果可预览（画布有内容）', preview.width === 128 && preview.painted === true, JSON.stringify(preview))
  check('结果条目带可下载/存图入口', restoredQueue[1]?.hasActions === true)

  const [restoredZipDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.click('#save-all'),
  ])
  const restoredZipEntries = readZipEntries(await readFile(await restoredZipDownload.path()))
  const restoredEntry = restoredZipEntries.find(entry => entry.name.startsWith('原图-'))
  check('ZIP 只含 1 个「原图」条目（坏图没有结果，不该混进去）',
    restoredZipEntries.length === 1 && !!restoredEntry, restoredZipEntries.map(entry => entry.name).join(', '))
  check('刷新恢复后的 ZIP 条目仍与输入逐字节一致',
    !!restoredEntry && sha256(restoredEntry.bytes) === cleanSha)
  check('刷新恢复后的 ZIP 条目 CRC 正确', restoredEntry?.crcOk === true)
} finally {
  await browser.close()
}

/* ---------------- 汇总 ---------------- */
console.log('\n=== 结果 ===')
for (const [label, ok, extra] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
}
console.log(`\n未捕获的页面异常 ${pageErrors.length} 条${pageErrors.length ? '：' + pageErrors.join(' | ') : ''}`)
console.log(`模型请求尝试 ${modelHits.length} 次，全部已被拦截（预热重试所致；本组用例不需要模型）`)
if (pageErrors.length) failed++
if (failed) throw new Error(`边界检查有 ${failed} 项未通过`)
console.log('\n✅ 边界行为全部符合预期（字节一致 / 原子拒绝 / 逐项隔离）')
