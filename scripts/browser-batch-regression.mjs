/**
 * 生产包 20 张真实图片回归（需要本机测试集，不进 CI）。
 *
 * 用法：
 *   TEST_URL_PREFIX=http://127.0.0.1:4173 \
 *     node scripts/browser-batch-regression.mjs "/Users/kunlun/Downloads/水印测试集" [count=20]
 *
 * 与 browser-batch-test.mjs 的区别：这一支专门验**批处理中途刷新**这条最脆弱的路径，
 * 并按本次修复的要求补上 ZIP 的逐字节比对：
 *
 *   1. 20 张混合图片（各平台轮转，另含 2 张无水印图以覆盖「保持原图」的字节一致性）
 *   2. 至少完成 2 张后**强制刷新**
 *   3. 恢复 20 张任务 + 与刷新前相同数量的结果
 *   4. 继续处理剩余图片 → 0 失败
 *   5. 全部完成后再刷新 → 20/20 全部还原
 *   6. 已完成批次不得重新初始化推理会话、也不得重新下载模型
 *   7. 生成 20 项 ZIP：CRC 全部通过，且所有「原图」条目与输入文件逐字节一致
 *
 * 注意：必须跑在 `vite preview` 的生产构建上（dist/），不是 dev server。
 */
import { chromium } from 'playwright'
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, extname, join } from 'node:path'

const root = process.argv[2] || process.env.TEST_SET
const wanted = Number(process.argv[3] || 20)
if (!root) throw new Error('用法：node scripts/browser-batch-regression.mjs <测试集目录> [张数]')
const url = process.env.TEST_URL_PREFIX || 'http://127.0.0.1:4173'

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')

/* ---------- 选图：各平台轮转，保证「混合」 ---------- */
const IMAGE = /\.(png|jpe?g|webp)$/i
async function filesBelow(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await filesBelow(absolute))
    else if (IMAGE.test(entry.name)) output.push(absolute)
  }
  return output.sort()
}

const folders = (await readdir(root, { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .map(entry => join(root, entry.name))
  .sort()
const pools = []
for (const folder of folders) {
  const files = await filesBelow(folder)
  pools.push({
    name: basename(folder),
    watermarked: files.filter(file => !/clean_/i.test(basename(file))),
    clean: files.filter(file => /clean_/i.test(basename(file))),
  })
}
const picked = []
const cleanTarget = Math.min(2, wanted - 1)
const watermarkedTarget = wanted - cleanTarget
while (picked.length < watermarkedTarget) {
  let progressed = false
  for (const pool of pools) {
    if (picked.length >= watermarkedTarget) break
    const next = pool.watermarked.shift()
    if (next) { picked.push(next); progressed = true }
  }
  if (!progressed) break
}
for (const pool of pools) {
  while (picked.length < wanted && pool.clean.length) picked.push(pool.clean.shift())
}
for (const pool of pools) {
  while (picked.length < wanted && pool.watermarked.length) picked.push(pool.watermarked.shift())
}
if (picked.length < wanted) throw new Error(`测试集只凑出 ${picked.length} 张，少于 ${wanted} 张`)

const inputs = new Map() // 去后缀文件名 → 输入文件路径（用于 ZIP 逐字节比对）
for (const file of picked) {
  const stem = basename(file, extname(file))
  const list = inputs.get(stem) || []
  list.push(file)
  inputs.set(stem, list)
}
console.log(`测试集：${picked.length} 张（混合 ${pools.length} 个平台目录，含 ${cleanTarget} 张无水印图）`)
for (const file of picked) console.log(`  · ${file.replace(root, '')}`)

/* ---------- ZIP 解析 ---------- */
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
    const declaredCrc = view.getUint32(offset + 14, true)
    const size = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const name = decoder.decode(buffer.subarray(offset + 30, offset + 30 + nameLength))
    const dataStart = offset + 30 + nameLength + extraLength
    const bytes = buffer.subarray(dataStart, dataStart + size)
    entries.push({ name, declaredCrc, bytes, crcOk: crc32(bytes) === declaredCrc })
    offset = dataStart + size
  }
  return entries
}

/* ---------- 浏览器 ---------- */
let failed = 0
const checks = []
const check = (label, ok, extra = '') => {
  checks.push([label, ok, extra])
  if (!ok) failed++
}

const browser = await chromium.launch(process.env.CHROME_PATH
  ? { executablePath: process.env.CHROME_PATH }
  : { channel: 'chrome' })
const context = await browser.newContext({ viewport: { width: 402, height: 874 }, acceptDownloads: true })
const page = await context.newPage()

const pageErrors = []
const threadLogs = []
const modelRequests = []
page.on('pageerror', error => pageErrors.push(String(error)))
page.on('console', message => { if (message.text().includes('推理线程')) threadLogs.push(message.text()) })
page.on('request', request => {
  if (/\/models\/|cdn\.jsdelivr\.net|huggingface\.co/.test(request.url())) modelRequests.push(request.url())
})

const readState = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('#queue > li')]
  const text = node => (node?.textContent || '').trim()
  return {
    queue: rows.length,
    done: rows.filter(row => row.classList.contains('done')).length,
    failed: rows.filter(row => row.classList.contains('failed')).length,
    unchanged: rows.filter(row => /未识别水印/.test(text(row.querySelector('.q-state')))).length,
    pending: rows.filter(row => /等待处理/.test(text(row.querySelector('.q-state')))).length,
    running: !document.querySelector('#stop')?.hidden,
    status: text(document.querySelector('#status')),
    thumbCount: rows.filter(row => /^blob:/.test(row.querySelector('img')?.getAttribute('src') || '')).length,
  }
})
const waitUntil = async (predicate, timeoutMs, label) => {
  const started = Date.now()
  let value = await readState()
  while (Date.now() - started < timeoutMs) {
    value = await readState()
    if (predicate(value)) return value
    await page.waitForTimeout(1000)
  }
  throw new Error(`${label} 超时；最后一次：${JSON.stringify(value)}`)
}

try {
  await page.goto(url, { waitUntil: 'load', timeout: 180000 })
  await page.reload({ waitUntil: 'load', timeout: 180000 })
  await page.waitForTimeout(2000)
  await page.evaluate(() => { const button = document.querySelector('#clear'); if (button && !button.hidden) button.click() })
  await page.waitForTimeout(1000)

  /* ---------- 1+2：跑批，完成 2 张后强制刷新 ---------- */
  console.log('\n=== 阶段 A：选 20 张 → 完成 ≥2 张后强制刷新 ===')
  await page.setInputFiles('#file-input', picked)
  await waitUntil(value => value.queue === wanted, 180000, '选入 20 张')
  await page.click('#run-batch')
  const partial = await waitUntil(value => value.done + value.unchanged >= 2 || value.failed > 0, 600000, '完成前 2 张')
  const completedBeforeReload = partial.done + partial.unchanged
  console.log(`  刷新前：已完成 ${partial.done} · 未识别 ${partial.unchanged} · 失败 ${partial.failed}（共 ${completedBeforeReload} 张有结果）`)
  await page.reload({ waitUntil: 'load', timeout: 180000 })

  /* ---------- 3：恢复 20 张任务与已有结果 ---------- */
  console.log('\n=== 阶段 B：刷新后恢复任务与结果 ===')
  const restored = await waitUntil(value => value.queue > 0, 120000, '恢复任务')
  console.log(`  恢复：队列 ${restored.queue} · 已完成 ${restored.done} · 未识别 ${restored.unchanged} · 待处理 ${restored.pending} · 缩略图 ${restored.thumbCount}`)
  const restoredResults = restored.done + restored.unchanged
  check(`恢复 20 张任务（实际 ${restored.queue}）`, restored.queue === wanted)
  // 用 `>=` 而不是 `==`：从「读到刷新前状态」到「真正发出刷新」之间还隔着一次 CDP 往返，
  // 那张正在跑的图有可能刚好在这几十毫秒里落盘 —— 那是更好的结果，不该判红。
  // 真正要守的是「结果不能丢」，以及队列/待处理数要与结果数自洽。
  check(`恢复刷新前已有的 ${completedBeforeReload} 个结果（实际 ${restoredResults}）`,
    restoredResults >= completedBeforeReload && restoredResults >= 2)
  check('待处理数 = 20 − 已有结果数（没有条目被凭空吞掉）',
    restored.pending === wanted - restoredResults, `${restored.pending} vs ${wanted - restoredResults}`)
  check('缩略图与有结果的条目数一致', restored.thumbCount === restoredResults)

  /* ---------- 4：继续处理剩余 ---------- */
  console.log('\n=== 阶段 C：继续处理剩余图片 ===')
  await page.click('#run-batch')
  const finished = await waitUntil(
    value => !value.running && value.done + value.unchanged + value.failed === wanted,
    2400000,
    '整批完成',
  )
  console.log(`  完成：已处理 ${finished.done} · 未识别 ${finished.unchanged} · 失败 ${finished.failed}`)
  console.log(`  状态：${finished.status}`)
  check('20 张全部处理完毕', finished.done + finished.unchanged + finished.failed === wanted)
  check('失败 0 张', finished.failed === 0)
  check('20 张都产出了结果（可预览/下载）', finished.done + finished.unchanged === wanted)

  /* ---------- 5+6：整批完成后再刷新，且不得重新初始化/下载模型 ---------- */
  console.log('\n=== 阶段 D：整批完成后再刷新（已完成批次不得重跑或重下模型）===')
  threadLogs.length = 0
  modelRequests.length = 0
  await page.reload({ waitUntil: 'load', timeout: 180000 })
  const finalState = await waitUntil(value => value.queue === wanted && value.pending === 0, 120000, '20/20 还原')
  await page.waitForTimeout(6000) // 留出「万一要预热」的时间窗
  console.log(`  还原：队列 ${finalState.queue} · 已完成 ${finalState.done} · 未识别 ${finalState.unchanged} · 待处理 ${finalState.pending}`)
  check('刷新后 20/20 全部还原', finalState.queue === wanted && finalState.done + finalState.unchanged === wanted)
  check('没有条目被打回待处理', finalState.pending === 0)
  check('没有为已完成批次重新初始化推理会话（仅 1 条基线日志）',
    threadLogs.length <= 1, `${threadLogs.length} 条「推理线程」日志`)
  // 口径要分清：「模型分片」（lama.part.NNN.bin，才是那 62MB）与「清单 JSON」不是一回事。
  // 每次打开页面 refreshCacheTags 都会拉一次清单（约 1KB）用于显示「已缓存」，
  // 那是既有行为、与预热无关；这里拦的是真的把模型拉下来。
  const chunkDownloads = modelRequests.filter(url => /lama\.part\.\d+\.bin/.test(url))
  const manifestFetches = modelRequests.filter(url => /manifest\.json/.test(url))
  check('没有为已完成批次下载模型分片', chunkDownloads.length === 0,
    `${chunkDownloads.length} 次分片请求 · 清单请求 ${manifestFetches.length} 次（显示缓存状态用，属既有行为）`)

  /* ---------- 7：ZIP 逐条 CRC + 原图逐字节一致 ---------- */
  console.log('\n=== 阶段 E：生成 20 项 ZIP 并逐条校验 ===')
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180000 }),
    page.click('#save-all'),
  ])
  const zipped = await readFile(await download.path())
  const entries = readZipEntries(zipped)
  console.log(`  ZIP ${(zipped.length / 1048576).toFixed(1)} MB · ${entries.length} 项`)
  check(`ZIP 条目数 = ${wanted}`, entries.length === wanted, String(entries.length))
  const badCrc = entries.filter(entry => !entry.crcOk)
  check('所有条目 CRC 通过', badCrc.length === 0, badCrc.map(entry => entry.name).join(', '))

  const originals = entries.filter(entry => entry.name.startsWith('原图-'))
  const mismatched = []
  const matchedFiles = []
  for (const entry of originals) {
    const stem = entry.name.replace(/^原图-\d+-/, '').replace(/\.[^.]+$/, '')
    const candidates = inputs.get(stem) || []
    let matched = null
    for (const candidate of candidates) {
      const bytes = await readFile(candidate)
      if (bytes.length === entry.bytes.length && sha256(bytes) === sha256(entry.bytes)) { matched = candidate; break }
    }
    if (matched) matchedFiles.push(matched)
    else mismatched.push(entry.name)
  }
  console.log(`  「原图」条目 ${originals.length} 项：${originals.map(entry => entry.name).join(', ') || '(无)'}`)
  check('「原图」条目数 ≥ 1（确实覆盖了保持原图路径）', originals.length >= 1, String(originals.length))
  check('所有「原图」条目与输入文件逐字节一致', mismatched.length === 0, mismatched.join(', '))
  check('「去水印」条目数 = 已完成数', entries.filter(entry => entry.name.startsWith('去水印-')).length === finalState.done,
    `${entries.filter(entry => entry.name.startsWith('去水印-')).length} vs ${finalState.done}`)

  check('浏览器异常为 0', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

console.log('\n=== 结果 ===')
for (const [label, ok, extra] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
}
if (failed) throw new Error(`20 张回归有 ${failed} 项未通过`)
console.log('\n✅ 20 张真实图片回归通过（中途刷新恢复 / 0 失败 / ZIP 逐字节一致）')
