/**
 * 「预计时间」显示的浏览器级验收。
 *
 * 用法：TEST_URL_PREFIX=http://127.0.0.1:4173 node scripts/browser-estimate-check.mjs
 *       NEXT_URL=https://kunlun7210.github.io/lama-watermark-web-next  （可选，做跨站并排比对）
 *
 * 验的是**用户看得见的那一行字**，不是代码：
 *   已选 2 张、每张按 8 秒估 → 「2 张预计 约 16 秒；请保持页面在前台，每完成一张会立即保存。」
 *   （这一条就是参考版 v0.4.4 在真机上的原话，逐字节比对）
 *
 * 覆盖：
 *   ① 无历史 → 回退 16 秒/张，文案正确
 *   ② 截图场景：2 张 × 8 秒 = 16 秒 → 「约 16 秒」
 *   ③ 用户场景：5 张 × 24 秒 = 120 秒 → 「约 2 分钟」（分钟分支 + 向上取整）
 *   ④ 边界：2 张 × 30 秒 = 60 秒 → 「约 1 分钟」（秒/分钟的分界点）
 *   ⑤ 边界：2 张 × 7.5 秒 = 15 秒 → 「约 15 秒」（小数先四舍五入）
 *   ⑥ 慢速：1 张 × 600 秒 → 「约 10 分钟」
 *   ⑦ 结构/位置/样式：#batch-hint 紧跟 #selected-name、可见、13px、#aab5c8
 *   ⑧ 清空列表 → 隐藏
 *   ⑨ 整批跑完 → 隐藏，且按 0.65/0.35 平滑写回历史
 *
 * 可选：给 NEXT_URL 时，会去参考站点用**同样的**每张秒数做一遍，
 * 把两边文案并排比对 —— 这是「和 Codex 新版一模一样」最直接的证据。
 */
import { chromium } from 'playwright'

const base = process.argv[2] || process.env.TEST_URL_PREFIX || 'http://127.0.0.1:4173'
const nextUrl = process.env.NEXT_URL || ''

const STABLE_PREFIX = 'lama-seconds-'
const NEXT_PREFIX = 'lama-next-seconds-'
/** 参考版 v0.4.4 真机截图里的原话（逐字节） */
const SCREENSHOT_TEXT = '2 张预计 约 16 秒；请保持页面在前台，每完成一张会立即保存。'

let failed = 0
const checks = []
const check = (label, ok, extra = '') => {
  checks.push([label, ok, extra])
  if (!ok) failed++
}

const browser = await chromium.launch(process.env.CHROME_PATH
  ? { executablePath: process.env.CHROME_PATH }
  : { channel: 'chrome' })

/** 打开一个站点并等到跨源隔离（GitHub Pages 靠 coi-serviceworker 自行 reload，脚本不能补刀） */
async function openSite(url, prefix) {
  const context = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))

  // 模型请求全程拦截：这组用例全是 128×128 干净图，走「未识别」路径，不需要推理
  await page.route('**/*', route => {
    const target = route.request().url()
    if (/\/models\/|cdn\.jsdelivr\.net|huggingface\.co|workbuddy\.host/.test(target)) return route.abort()
    return route.continue()
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setBlockedURLs', {
    urls: ['*://*/models/*', '*cdn.jsdelivr.net*', '*huggingface.co*', '*lama-watermark.app.workbuddy.host*'],
  })

  await page.goto(url, { waitUntil: 'load', timeout: 180000 })
  let isolated = false
  for (let attempt = 0; attempt < 40; attempt++) {
    isolated = await page.evaluate(() => crossOriginIsolated).catch(() => false)
    if (isolated) break
    await page.waitForTimeout(1000)
  }
  await page.waitForTimeout(1200)
  return { context, page, errors, isolated, prefix }
}

/** 读提示行的完整状态：文案 / 可见性 / 结构 / 计算样式 */
const readHint = site => site.page.evaluate(() => {
  const hint = document.querySelector('#batch-hint')
  if (!hint) return { exists: false }
  const style = getComputedStyle(hint)
  const box = hint.getBoundingClientRect()
  return {
    exists: true,
    text: (hint.textContent || '').trim(),
    hidden: hint.hidden,
    afterSelectedName: document.querySelector('#selected-name')?.nextElementSibling === hint,
    tagName: hint.tagName,
    className: hint.className,
    display: style.display,
    color: style.color,
    fontSize: style.fontSize,
    width: Math.round(box.width),
    height: Math.round(box.height),
  }
})

const seed = (site, seconds) => site.page.evaluate(([prefix, value]) => {
  if (value === null) localStorage.removeItem(`${prefix}int8`)
  else localStorage.setItem(`${prefix}int8`, String(value))
}, [site.prefix, seconds])

const storedSeconds = site => site.page.evaluate(prefix => localStorage.getItem(`${prefix}int8`), site.prefix)

const clearList = async site => {
  await site.page.evaluate(() => {
    const button = document.querySelector('#clear')
    if (button && !button.hidden) button.click()
  })
  await site.page.waitForTimeout(800)
  // 清空会让应用写入「不恢复」标记，与本组用例无关，但会顺带清掉我们种的历史
  return seed(site, null)
}

const selectFiles = async (site, count, namePrefix) => {
  const files = Array.from({ length: count }, (_, index) => ({
    name: `${namePrefix}-${String(index + 1).padStart(2, '0')}.jpg`,
    mimeType: 'image/jpeg',
    buffer: site.jpeg,
  }))
  await site.page.setInputFiles('#file-input', files)
  await site.page.waitForTimeout(1200)
}

const EXPECTED_RE = /^\d+ 张预计 约 \d+ (秒|分钟)；请保持页面在前台，每完成一张会立即保存。$/

let nextSite = null
try {
  const site = await openSite(base, STABLE_PREFIX)
  check('页面已跨源隔离（ORT 多线程前提）', site.isolated === true)
  check('#batch-hint 元素存在', (await readHint(site)).exists === true)

  // 固定夹具：128×128 渐变（无任何平台水印特征）→ 走「未识别 · 保持原图」
  site.jpeg = Buffer.from(await site.page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 128
    const context = canvas.getContext('2d')
    const gradient = context.createLinearGradient(0, 0, 128, 128)
    gradient.addColorStop(0, '#3f6d9e')
    gradient.addColorStop(0.5, '#8fb7c9')
    gradient.addColorStop(1, '#e8d9b8')
    context.fillStyle = gradient
    context.fillRect(0, 0, 128, 128)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92))
    return [...new Uint8Array(await blob.arrayBuffer())]
  }))

  /* ================= ① 无历史 → 回退值 ================= */
  console.log('\n=== ① 无历史：回退 16 秒/张 ===')
  await clearList(site)
  await selectFiles(site, 1, 'est-fallback')
  const fallback = await readHint(site)
  check('显示「1 张预计 约 16 秒；…」（int8 回退值）',
    fallback.text === '1 张预计 约 16 秒；请保持页面在前台，每完成一张会立即保存。' && fallback.hidden === false,
    JSON.stringify(fallback.text))

  /* ================= ② 截图场景 ================= */
  console.log('\n=== ② 截图场景：2 张 × 8 秒 ===')
  await clearList(site)
  await seed(site, 8)
  await selectFiles(site, 2, 'est-shot')
  const shot = await readHint(site)
  check('文案与参考版 v0.4.4 真机截图逐字节一致', shot.text === SCREENSHOT_TEXT, JSON.stringify(shot.text))
  check('提示可见（hidden = false）', shot.hidden === false, String(shot.hidden))

  /* ================= ③ 用户场景：分钟分支 ================= */
  console.log('\n=== ③ 用户场景：5 张 × 24 秒 = 120 秒 ===')
  await clearList(site)
  await seed(site, 24)
  await selectFiles(site, 5, 'est-user')
  const userCase = await readHint(site)
  check('文案为「5 张预计 约 2 分钟；…」（向上取整）',
    userCase.text === '5 张预计 约 2 分钟；请保持页面在前台，每完成一张会立即保存。',
    JSON.stringify(userCase.text))

  /* ================= ④⑤⑥ 边界值 ================= */
  console.log('\n=== ④⑤⑥ 边界：60 秒 / 15 秒 / 600 秒 ===')
  const boundaries = [
    { seconds: 30, count: 2, expect: '2 张预计 约 1 分钟；请保持页面在前台，每完成一张会立即保存。', label: '60 秒整 → 「约 1 分钟」（秒/分钟分界）' },
    { seconds: 7.5, count: 2, expect: '2 张预计 约 15 秒；请保持页面在前台，每完成一张会立即保存。', label: '7.5 秒 × 2 → 「约 15 秒」（小数四舍五入）' },
    { seconds: 600, count: 1, expect: '1 张预计 约 10 分钟；请保持页面在前台，每完成一张会立即保存。', label: '600 秒 → 「约 10 分钟」' },
  ]
  for (const row of boundaries) {
    await clearList(site)
    await seed(site, row.seconds)
    await selectFiles(site, row.count, `est-${row.seconds}`)
    const hint = await readHint(site)
    check(row.label, hint.text === row.expect, JSON.stringify(hint.text))
  }

  /* ================= ⑦ 结构 / 位置 / 样式 ================= */
  console.log('\n=== ⑦ 结构 / 位置 / 样式 ===')
  const structural = await readHint(site)
  check('紧跟 #selected-name（nextElementSibling）', structural.afterSelectedName === true)
  check('是 <p class="batch-hint">', structural.tagName === 'P' && structural.className === 'batch-hint',
    `${structural.tagName}.${structural.className}`)
  check('行内可见（display 非 none、高度非 0）', structural.display !== 'none' && structural.height > 0,
    `display=${structural.display} ${structural.width}×${structural.height}`)
  check('样式与参考版一致（13px / #aab5c8）',
    structural.fontSize === '13px' && structural.color === 'rgb(170, 181, 200)',
    `${structural.fontSize} · ${structural.color}`)

  /* ================= ⑧ 清空 → 隐藏 ================= */
  console.log('\n=== ⑧ 清空列表 → 提示隐藏 ===')
  await clearList(site)
  const afterClear = await readHint(site)
  check('清空后隐藏', afterClear.hidden === true, String(afterClear.hidden))

  /* ================= ⑨ 整批跑完 → 隐藏 + 回写历史 ================= */
  console.log('\n=== ⑨ 整批处理：过程中刷新剩余张数、结束后隐藏并写回历史 ===')
  await seed(site, 8)
  await selectFiles(site, 2, 'est-run')
  const beforeRun = await storedSeconds(site)
  const seen = []
  await site.page.click('#run-batch')
  for (let tick = 0; tick < 400; tick++) {
    const sample = await site.page.evaluate(() => {
      const hint = document.querySelector('#batch-hint')
      const status = (document.querySelector('#status')?.textContent || '').trim()
      return { text: hint && !hint.hidden ? (hint.textContent || '').trim() : '', status }
    })
    if (sample.text && !seen.includes(sample.text)) seen.push(sample.text)
    if (/批量处理完成|已停止/.test(sample.status)) break
    await site.page.waitForTimeout(60)
  }
  await site.page.waitForTimeout(600)

  const duringOk = seen.every(text => EXPECTED_RE.test(text))
  const counts = seen.map(text => Number(text.match(/^(\d+) 张/)[1])).filter(Number.isFinite)
  const nonIncreasing = counts.every((value, index) => index === 0 || value <= counts[index - 1])
  check('处理过程中提示的文案格式全部合法', seen.length > 0 && duringOk, `观测到 ${seen.length} 种：${seen.join(' | ') || '（无）'}`)
  check('处理过程中张数单调不增（刷新的是剩余张数）', nonIncreasing, counts.join(' → ') || '（无）')

  const afterRun = await readHint(site)
  check('整批结束后提示隐藏', afterRun.hidden === true, String(afterRun.hidden))

  // 写回公式：每处理完一张调用一次 rememberTiming，值为 old×0.65 + 实测×0.35（保留两位）。
  // 两张就是递推两次，所以最终值不是「old×0.65 + t×0.35」这种单步形式 ——
  // 直接按单步反推会得出负数（本脚本初版就是这么误报的）。
  // 正确的做法：按**递推区间**判定 —— 假设每张耗时落在 [minT, maxT] 之内，
  // 那么最终值必须落在递推能到达的区间里。公式对不上、写 0、没写、写原始值，都会掉出区间。
  const storedAfter = await storedSeconds(site)
  const minT = 0.05
  const maxT = 120
  let low = Number(beforeRun)
  let high = Number(beforeRun)
  for (let index = 0; index < 2; index++) {
    low = low * 0.65 + minT * 0.35
    high = high * 0.65 + maxT * 0.35
  }
  const value = Number(storedAfter)
  check('历史值已按 0.65/0.35 平滑写回（两张 = 递推两次）',
    /^\d+\.\d{2}$/.test(String(storedAfter)) && value >= low - 0.011 && value <= high + 0.011,
    `${beforeRun} → ${storedAfter}，递推区间 [${low.toFixed(2)}, ${high.toFixed(2)}]`)

  /* 单张批次：只有一次写入，可以精确反推出实测耗时 —— 这是「写回值用的是真实耗时」的硬证据 */
  console.log('  · 单张批次：精确反推实测耗时')
  await clearList(site)
  await seed(site, 8)
  await selectFiles(site, 1, 'est-single')
  const singleBefore = Number(await storedSeconds(site))
  await site.page.click('#run-batch')
  await site.page.waitForFunction(() => /批量处理完成|已停止/.test(document.querySelector('#status')?.textContent || ''), { timeout: 300000 }).catch(() => {})
  await site.page.waitForTimeout(600)
  const singleAfter = Number(await storedSeconds(site))
  const solvedSingle = (singleAfter - singleBefore * 0.65) / 0.35
  check('单张批次：写回值 = 8×0.65 + 实测×0.35（反推出的实测值合理）',
    solvedSingle > 0.05 && solvedSingle < 120,
    `8 → ${singleAfter}，反推实测 ${solvedSingle.toFixed(3)} 秒`)

  /* ================= ⑩ 跨站并排比对（可选） ================= */
  if (nextUrl) {
    console.log(`\n=== ⑩ 与参考站点并排比对：${nextUrl} ===`)
    nextSite = await openSite(nextUrl, NEXT_PREFIX)
    check('参考站点已跨源隔离', nextSite.isolated === true)
    nextSite.jpeg = site.jpeg
    await clearList(nextSite)

    for (const row of [
      { seconds: 8, count: 2 },
      { seconds: 24, count: 5 },
      { seconds: 30, count: 2 },
      { seconds: 7.5, count: 2 },
    ]) {
      await clearList(nextSite)
      await seed(nextSite, row.seconds)
      await selectFiles(nextSite, row.count, `parity-${row.seconds}`)
      const theirs = (await readHint(nextSite)).text

      await clearList(site)
      await seed(site, row.seconds)
      await selectFiles(site, row.count, `parity-${row.seconds}`)
      const ours = (await readHint(site)).text

      check(`与参考站点逐字节一致：${row.count} 张 × ${row.seconds} 秒`,
        ours === theirs && ours.length > 0,
        ours === theirs ? JSON.stringify(ours) : `本仓 ${JSON.stringify(ours)} ≠ 参考 ${JSON.stringify(theirs)}`)
    }
  }

  /* ================= 结果 ================= */
  console.log('\n=== 结果 ===')
  for (const [label, ok, extra] of checks) console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
  const allErrors = [...site.errors, ...(nextSite?.errors || [])]
  console.log(`\n未捕获的页面异常 ${allErrors.length} 条`)
  for (const error of allErrors.slice(0, 5)) console.log(`  · ${error}`)

  if (failed || allErrors.length) {
    console.error(`\n❌ 预计时间显示验收未通过：${failed} 项断言失败，异常 ${allErrors.length} 条`)
    process.exitCode = 1
  } else {
    console.log('\n✅ 预计时间显示验收通过：文案、边界、结构、样式、回写历史全部符合预期')
  }
} finally {
  await browser.close()
}
