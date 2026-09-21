/**
 * 正式 Pages 的发布后验收（第六项 6 的最后 10 条）。
 *
 * 用法：
 *   node scripts/verify-live-deploy.mjs https://kunlun7210.github.io/lama-watermark-web/ \
 *     "/Users/kunlun/Downloads/水印测试集/豆包水印测试图/<某张>.PNG"
 *
 * 做三件事，都要求有证据：
 *   1. 资源可达：首页、version.json、稳定入口 app.js/app.css、两个旧入口迁移文件、
 *      COI Service Worker 全部 200。
 *   2. 与本地已验证构建**逐字节比对**，只把 14 位构建版本/日期归一化 ——
 *      证明线上跑的就是这份源码构建的产物，而不是"看起来差不多"。
 *   3. 全新浏览器配置打开线上页面（冷缓存）：跨源隔离成立 → 真实水印图跑完 INT8 推理，
 *      并记录模型分片实际来自哪个源。
 */
import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'

const live = (process.argv[2] || 'https://kunlun7210.github.io/lama-watermark-web/').replace(/\/$/, '')
const sample = process.argv[3]
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(repoRoot, 'dist')

const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
const expectedSemver = `v${pkg.version}`
const localVersion = JSON.parse(await readFile(join(distDir, 'version.json'), 'utf8')).version

let failed = 0
const checks = []
// 立即打印：后面一旦有步骤抛错，前面已经拿到的证据不会一起丢掉
const check = (label, ok, extra = '') => {
  checks.push([label, ok, extra])
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failed++
}

/** 把 14 位构建版本与界面日期归一化：这是唯一允许不同的东西 */
const normalize = text => String(text)
  .replace(/\d{14}/g, '<STAMP>')
  .replace(/\d{4}\.\d{2}\.\d{2}/g, '<DATE>')

/* ---------- 1 + 2：资源可达与产物等价 ---------- */
console.log(`线上地址：${live}`)
const liveVersion = await (await fetch(`${live}/version.json`, { cache: 'no-store' })).json()
console.log(`线上构建版本：${liveVersion.version}（本地最后一次构建：${localVersion}）`)
check('线上 version.json 是可解析的 14 位构建版本', /^\d{14}$/.test(String(liveVersion.version)))

const stamp = liveVersion.version
const resources = [
  ['index.html', `${live}/index.html`],
  ['assets/app.js', `${live}/assets/app.js?v=${stamp}`],
  ['assets/app.css', `${live}/assets/app.css?v=${stamp}`],
  ['assets/index-DiAJy31j.js', `${live}/assets/index-DiAJy31j.js`],
  ['assets/index-BlVSS6-9.css', `${live}/assets/index-BlVSS6-9.css`],
  ['coi-serviceworker.min.js', `${live}/coi-serviceworker.min.js`],
  ['version.json', `${live}/version.json`],
]
const liveBytes = new Map()
for (const [name, url] of resources) {
  const response = await fetch(url, { cache: 'no-store' })
  const buffer = Buffer.from(await response.arrayBuffer())
  liveBytes.set(name, buffer)
  check(`${name} 返回 200`, response.status === 200, `HTTP ${response.status} · ${buffer.length} 字节`)
}

// 首页里必须引用稳定入口（迁移完成的标志）
const liveHtml = liveBytes.get('index.html').toString('utf8')
check('线上首页引用固定入口 assets/app.js（不再带内容哈希）',
  /assets\/app\.js\?v=\d{14}/.test(liveHtml) && !/assets\/index-[A-Za-z0-9_-]+\.js/.test(liveHtml))

for (const name of ['index.html', 'assets/app.js', 'assets/app.css', 'assets/index-DiAJy31j.js', 'coi-serviceworker.min.js']) {
  const localName = name === 'index.html' ? 'index.html' : name
  let local
  try { local = await readFile(join(distDir, localName)) } catch {
    check(`本地构建含 ${name}（可比对）`, false)
    continue
  }
  const same = normalize(local.toString('utf8')) === normalize(liveBytes.get(name).toString('utf8'))
  check(`${name} 与本地已验证构建一致（归一化构建版本后逐字符比对）`, same,
    same ? `${local.length} → ${liveBytes.get(name).length} 字节` : `本地 ${local.length} / 线上 ${liveBytes.get(name).length} 字节`)
}

/* ---------- 3：全新配置冷缓存实跑 ---------- */
console.log('\n=== 全新浏览器配置 · 冷缓存实测 ===')
const browser = await chromium.launch(process.env.CHROME_PATH
  ? { executablePath: process.env.CHROME_PATH }
  : { channel: 'chrome' })
try {
  // 全新 context = 全新存储：IndexedDB / Cache Storage 都是空的，即"冷缓存"
  const context = await browser.newContext({ viewport: { width: 402, height: 874 } })
  const page = await context.newPage()
  const pageErrors = []
  const chunkSources = []
  page.on('pageerror', error => pageErrors.push(String(error)))
  page.on('request', request => {
    if (/lama\.part\.\d+\.bin/.test(request.url())) {
      const host = new URL(request.url()).host
      if (!chunkSources.includes(host)) chunkSources.push(host)
    }
  })

  await page.goto(`${live}/`, { waitUntil: 'load', timeout: 180000 })
  // ⚠️ 这里**不要**主动 reload：GitHub Pages 不执行仓库里的 _headers，跨源隔离要靠
  // coi-serviceworker 注册后自行 reload 一次才能生效。我们再 reload 一次就会与它撞车
  // （实测报 net::ERR_ABORTED / frame was detached）。改为轮询等隔离生效。
  let isolated = false
  for (let attempt = 0; attempt < 40; attempt++) {
    isolated = await page.evaluate(() => crossOriginIsolated).catch(() => false)
    if (isolated) break
    await page.waitForTimeout(1000)
  }
  await page.waitForTimeout(2000)

  const initial = await page.evaluate(() => ({
    url: location.href,
    version: (document.querySelector('#app-version')?.textContent || '').trim(),
    status: (document.querySelector('#status')?.textContent || '').trim(),
    crossOriginIsolated,
    cacheEmpty: performance.getEntriesByType('resource').filter(entry => /lama\.part\./.test(entry.name)).length === 0,
  }))
  console.log(`  版本显示：${initial.version} · 状态：${initial.status}`)
  check('线上页面显示当前语义版本 ' + expectedSemver,
    new RegExp(`^${expectedSemver.replace(/[.]/g, '\\.')} · \\d{4}\\.\\d{2}\\.\\d{2}$`).test(initial.version), initial.version)
  check('初始状态为「等待选择图片」', initial.status === '等待选择图片', initial.status)
  check('crossOriginIsolated === true', initial.crossOriginIsolated === true)
  check('冷缓存成立（进入页面前没有任何模型分片）', initial.cacheEmpty === true)

  if (sample) {
    console.log(`  真实水印样张：${basename(sample)}`)
    await page.setInputFiles('#file-input', [sample])
    await page.waitForTimeout(1500)
    await page.click('#run-batch')
    try {
      await page.waitForFunction(
        () => /批量处理完成/.test(document.querySelector('#status')?.textContent || ''),
        { timeout: 600000 },
      )
    } catch { /* 下面按实际状态判定 */ }
    const result = await page.evaluate(() => {
      const row = document.querySelector('#queue > li')
      return {
        state: (row?.querySelector('.q-state')?.textContent || '').trim(),
        status: (document.querySelector('#status')?.textContent || '').trim(),
        source: document.querySelector('#download-status')?.textContent || '',
      }
    })
    console.log(`  处理结果：${result.state}`)
    console.log(`  模型分片来源：${chunkSources.join(', ') || '(无)'}`)
    check('真实水印图完成 INT8 推理并识别出平台', /已去除 ·/.test(result.state), result.state)
    check('模型分片来自预期来源（jsDelivr / HuggingFace / 同源）',
      chunkSources.length > 0 && chunkSources.every(host => /jsdelivr\.net|huggingface\.co|github\.io/.test(host)),
      chunkSources.join(', '))
  } else {
    console.log('  （未提供样张，跳过冷缓存推理实测）')
  }

  check('浏览器异常为 0', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

console.log('\n=== 结果 ===')
for (const [label, ok, extra] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
}
if (failed) throw new Error(`线上验收有 ${failed} 项未通过`)
console.log(`\n✅ 线上（${live}）验收通过：资源可达、产物与本地构建等价、冷缓存推理正常`)
