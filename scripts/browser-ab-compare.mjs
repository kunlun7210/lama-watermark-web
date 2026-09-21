/**
 * A/B 对照：把两套实现放在**同等条件**下跑同一批样张，并读出主线程阻塞量。
 *
 * 为什么不能只看端到端耗时：把推理搬进 Worker、加缓存、改并发这类改动，
 * 目的往往是"释放主线程"而不是"总耗时变短"。端到端耗时回答不了"界面还卡不卡"。
 * 本脚本因此同时读三项：
 *   - 逐张耗时 / 整批墙钟
 *   - 页内 50ms 心跳的**平均**间隔（只报 max 会被一次性长任务带偏）
 *   - PerformanceObserver longtask 的个数 / 累计 / 最长
 *
 * ⚠️ 每个 URL 用**独立的浏览器实例**：同一个实例里第二次跑会命中缓存与预热，
 * 拿它跟第一次比就成了"先跑的吃亏"，结论会反。
 *
 * 用法（需系统 Chrome，longtask 在 WebKit 上不可用）：
 *   node scripts/browser-ab-compare.mjs <urlA> <urlB> [样张...]
 *
 * 典型场景：
 *   - 对比改造前后：先用 `git worktree` 各起一个本地服务，再传两个 URL
 *   - 对比线上两站：直接传两个 Pages / 托管地址
 */
import { chromium, devices } from 'playwright'

const urlA = process.argv[2]
const urlB = process.argv[3]
const samples = process.argv.slice(4)
if (!urlA || !urlB || !samples.length) {
  console.error('用法：node scripts/browser-ab-compare.mjs <urlA> <urlB> <样张...>')
  process.exit(2)
}

const PROBE = `(() => {
  window.__probe = { ticks: 0, gaps: [], long: [] }
  let last = performance.now()
  const beat = () => {
    const now = performance.now()
    window.__probe.gaps.push(now - last)
    last = now
    window.__probe.ticks += 1
    setTimeout(beat, 50)
  }
  setTimeout(beat, 50)
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__probe.long.push(Math.round(entry.duration))
    }).observe({ entryTypes: ['longtask'] })
  } catch { /* 不支持 longtask 的引擎：只保留心跳读数 */ }
  return true
})()`

async function measure(label, url) {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ ...devices['iPhone 15 Pro'] })
  const page = await context.newPage()
  // jsDelivr 在 COEP 下必然被拦、应用会自动换源到同源，属预期内噪音，不计入异常。
  const KNOWN_NOISE = /cdn\.jsdelivr\.net[\s\S]*access control checks/i
  const errors = []
  page.on('pageerror', error => {
    const text = String(error)
    if (!KNOWN_NOISE.test(text)) errors.push(text.slice(0, 140))
  })

  const navStart = Date.now()
  await page.goto(url, { waitUntil: 'load', timeout: 240000 })
  await page.reload({ waitUntil: 'load', timeout: 240000 })
  const openMs = Date.now() - navStart
  await page.waitForTimeout(1500)

  const ready = await page.evaluate(() => !!document.querySelector('#file-input') && !!document.querySelector('#run-batch'))
  console.log(`\n=== ${label}（${url}）===`)
  if (!ready) {
    console.log('  ⚠ 找不到 #file-input / #run-batch，跳过')
    await browser.close()
    return null
  }

  await page.evaluate(PROBE)

  const batchStart = Date.now()
  const perSample = []
  for (const sample of samples) {
    if (perSample.length) {
      await page.evaluate(() => { const clear = document.querySelector('#clear'); if (clear && !clear.hidden) clear.click() })
      await page.waitForTimeout(1000)
    }
    const started = Date.now()
    await page.setInputFiles('#file-input', sample)
    await page.waitForTimeout(1600)
    await page.click('#run-batch')
    let done = true
    try {
      await page.waitForFunction(
        () => /批量处理完成/.test(document.querySelector('#status')?.textContent || ''),
        { timeout: 300000 },
      )
    } catch { done = false }
    const ms = Date.now() - started
    perSample.push(ms)
    const state = await page.evaluate(() => (document.querySelector('#queue > li .q-state')?.textContent || '').trim().slice(0, 34))
    console.log(`  ${done ? '✓' : '✗'} ${sample.split('/').pop().slice(0, 32).padEnd(34)} ${(ms / 1000).toFixed(1).padStart(6)}s  ${state}`)
  }
  const batchMs = Date.now() - batchStart

  const probe = await page.evaluate(() => ({
    gaps: window.__probe.gaps,
    long: window.__probe.long,
  }))
  const avgGap = probe.gaps.length ? Math.round(probe.gaps.reduce((a, b) => a + b, 0) / probe.gaps.length) : null
  const maxGap = probe.gaps.length ? Math.round(Math.max(...probe.gaps)) : null
  const longCount = probe.long.length
  const longTotal = probe.long.reduce((a, b) => a + b, 0)
  const longMax = longCount ? Math.max(...probe.long) : 0

  console.log(`  打开 + 重载 ${(openMs / 1000).toFixed(1)}s ｜ 整批墙钟 ${(batchMs / 1000).toFixed(1)}s`)
  console.log(`  心跳 ${probe.gaps.length} 次，平均 ${avgGap} ms，最长 ${maxGap} ms`)
  console.log(`  长任务 ${longCount} 个，累计 ${longTotal} ms，最长 ${longMax} ms`)
  console.log(`  页面异常 ${errors.length}${errors.length ? ' → ' + errors[0] : ''}`)

  await browser.close()
  return { label, url, openMs, batchMs, perSample, avgGap, maxGap, longCount, longTotal, longMax, errors: errors.length }
}

console.log('=== A/B 对照（各自独立浏览器实例 · 同一批样张 · 依次执行）===')
console.log(`样张 ${samples.length} 张：${samples.map(s => s.split('/').pop().slice(0, 20)).join(' → ')}`)
const a = await measure('A', urlA)
const b = await measure('B', urlB)

if (!a || !b) {
  console.log('\n⚠ 有一侧未跑完，无法对比')
  process.exit(1)
}

const row = (name, va, vb, unit = '') => `  ${name.padEnd(22)}${String(va + unit).padStart(14)}${String(vb + unit).padStart(14)}`
console.log('\n=== 汇总 ===')
console.log('  ' + '指标'.padEnd(22) + 'A'.padStart(14) + 'B'.padStart(14))
console.log(row('打开 + 重载', (a.openMs / 1000).toFixed(1), (b.openMs / 1000).toFixed(1), ' s'))
console.log(row('整批墙钟', (a.batchMs / 1000).toFixed(1), (b.batchMs / 1000).toFixed(1), ' s'))
console.log(row('心跳平均间隔', a.avgGap, b.avgGap, ' ms'))
console.log(row('心跳最长间隔', a.maxGap, b.maxGap, ' ms'))
console.log(row('长任务个数', a.longCount, b.longCount))
console.log(row('长任务累计', a.longTotal, b.longTotal, ' ms'))
console.log(row('长任务最长', a.longMax, b.longMax, ' ms'))
console.log(row('页面异常', a.errors, b.errors))
console.log('\n注：性能读数只作对照，不设通过阈值 —— 绝对值依赖机器与图片，硬断言会变成 flaky。')
