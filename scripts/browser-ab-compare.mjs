/**
 * A/B 对照：把两套实现放在同等条件下**交替重复**测量，并读出主线程阻塞量。
 *
 * ── 为什么这么写 ──────────────────────────────────────────────
 * 把推理搬进 Worker、加缓存、改并发这类改动，目的往往是"释放主线程"而不是
 * "总耗时变短"。端到端耗时回答不了"界面还卡不卡"，所以同时读耗时与主线程读数。
 *
 * 1) **必须交替测量，不能"跑完 A 再跑 B"**。
 *    实测教训：同一版本（v0.11.2）在两次实验里分别测出 7554 ms 与 12184 ms，
 *    差了 61% —— 顺序测量时整侧共用同一个时间窗口，系统负载/热节流的漂移
 *    会全部算到某一侧头上。改成"同一轮里 A 一次、B 一次"，漂移就被平摊了。
 * 2) **先各跑一轮预热并丢弃**：让模型下载与初始化发生在计数之外，
 *    否则两侧的第一轮都混着模型加载，彼此不可比。
 * 3) **心跳报 avg / p50 / p95 / p99 / max**：只看平均会掩盖长尾，
 *    而长尾正是"卡一下"的体感来源；只报 max 又会被一次性长任务带偏。
 *    实测中两侧 p50 都是 51 ms，差异全在 p95/p99（3739 ms vs 52 ms）。
 * 4) **正式数据用生产构建**；`--minify false` / sourcemap 只用于第二轮函数归因
 *    （压缩后函数名是 f/m，采不到）。
 *
 * ⚠️ **对照版本必须只差被测的那一个变量**。用旧版本当对照前先跑
 *    `git diff --stat <旧> <新>` 确认识别/存储/模型加载逻辑没动 —— 并把这条依据写进报告。
 *    实测教训：曾拿 v0.11.2 对 v0.16.1，中间隔了四个版本，结论完全反过来。
 *
 * 不设通过阈值、不进 CI：云主机负载波动大，而且目标设备是手机浏览器，
 * 桌面读数不能代表它。这是**专项性能报告**，不是门禁。
 *
 * 用法：
 *   node scripts/browser-ab-compare.mjs <urlA> <urlB> <样张...> [--repeat=5]
 */
import { chromium, devices } from 'playwright'

const argv = process.argv.slice(2)
const repeatArg = argv.find(a => a.startsWith('--repeat='))
const REPEAT = Math.max(1, Number(repeatArg?.split('=')[1]) || 5)
const positional = argv.filter(a => !a.startsWith('--'))
const [urlA, urlB, ...samples] = positional

if (!urlA || !urlB || !samples.length) {
  console.error('用法：node scripts/browser-ab-compare.mjs <urlA> <urlB> <样张...> [--repeat=5]')
  process.exit(2)
}

/** 页内探针：50ms 心跳 + longtask 观察器。reload 会清掉，所以要在页面稳定后注入。 */
const PROBE = `(() => {
  window.__probe = { gaps: [], long: [] }
  let last = performance.now()
  const beat = () => {
    const now = performance.now()
    window.__probe.gaps.push(now - last)
    last = now
    setTimeout(beat, 50)
  }
  setTimeout(beat, 50)
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__probe.long.push(Math.round(entry.duration))
    }).observe({ entryTypes: ['longtask'] })
  } catch { /* 不支持 longtask：只保留心跳 */ }
  return true
})()`

const quantile = (values, q) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo))
}
const mean = values => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null)

async function openSession(label, url) {
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

  const openStart = Date.now()
  await page.goto(url, { waitUntil: 'load', timeout: 240000 })
  await page.reload({ waitUntil: 'load', timeout: 240000 })
  const openMs = Date.now() - openStart
  await page.waitForTimeout(1200)

  const ready = await page.evaluate(() => !!document.querySelector('#file-input') && !!document.querySelector('#run-batch'))
  console.log(`\n=== ${label}（${url}）===`)
  if (!ready) {
    console.log('  ⚠ 找不到 #file-input / #run-batch')
    await browser.close()
    return null
  }
  await page.evaluate(PROBE)
  return { label, url, browser, page, errors, openMs }
}

async function runRound(session) {
  const { page } = session
  // 每轮先清空列表并**重置文件输入**：同一个文件连续上传两次时，
  // 浏览器会因为 input.value 没变而不触发 change，页面收不到文件 → 按钮一直 disabled。
  // value 只能置空（浏览器安全限制），这也正是清空它的标准做法。
  const reset = () => page.evaluate(() => {
    const clear = document.querySelector('#clear')
    if (clear && !clear.hidden) clear.click()
    const input = document.querySelector('#file-input')
    if (input) input.value = ''
  })

  await reset()
  await page.waitForTimeout(800)
  await page.evaluate(() => { window.__probe.gaps.length = 0; window.__probe.long.length = 0 })

  const perSample = []
  const roundStart = Date.now()
  for (let index = 0; index < samples.length; index++) {
    if (index) { await reset(); await page.waitForTimeout(800) }
    const started = Date.now()
    await page.setInputFiles('#file-input', samples[index])
    // 等按钮真的可用再点：固定 sleep 在不同版本上不可靠（旧版上传后处理更慢）。
    await page.waitForFunction(
      () => { const button = document.querySelector('#run-batch'); return !!button && !button.disabled },
      { timeout: 60000 },
    )
    await page.click('#run-batch')
    try {
      await page.waitForFunction(
        () => /批量处理完成/.test(document.querySelector('#status')?.textContent || ''),
        { timeout: 300000 },
      )
    } catch { /* 超时仍记录 */ }
    perSample.push(Date.now() - started)
  }

  const probe = await page.evaluate(() => ({ gaps: window.__probe.gaps, long: window.__probe.long }))
  const longTotal = probe.long.reduce((a, b) => a + b, 0)
  return {
    perSample,
    wallMs: Date.now() - roundStart,
    gaps: probe.gaps,
    longCount: probe.long.length,
    longTotal,
    longMax: probe.long.length ? Math.max(...probe.long) : 0,
  }
}

function summarize(session, rounds) {
  const allPerSample = rounds.flatMap(r => r.perSample)
  const allGaps = rounds.flatMap(r => r.gaps)
  const walls = rounds.map(r => r.wallMs)
  const totalWall = walls.reduce((a, b) => a + b, 0)
  const totalImages = rounds.length * samples.length
  return {
    label: session.label,
    url: session.url,
    openMs: session.openMs,
    errors: session.errors.length,
    perSample: {
      avg: mean(allPerSample), p50: quantile(allPerSample, 0.5), p95: quantile(allPerSample, 0.95),
      p99: quantile(allPerSample, 0.99), max: Math.max(...allPerSample),
    },
    gap: {
      avg: mean(allGaps), p50: quantile(allGaps, 0.5), p95: quantile(allGaps, 0.95),
      p99: quantile(allGaps, 0.99), max: Math.max(...allGaps), count: allGaps.length,
    },
    long: {
      avgCount: (rounds.reduce((a, r) => a + r.longCount, 0) / rounds.length).toFixed(1),
      avgTotal: mean(rounds.map(r => r.longTotal)),
      max: Math.max(...rounds.map(r => r.longMax)),
    },
    wall: { avg: mean(walls), p50: quantile(walls, 0.5), max: Math.max(...walls) },
    throughput: totalWall > 0 ? totalImages / (totalWall / 60000) : 0,
  }
}

console.log(`=== A/B 对照（交替测量 ${REPEAT} 轮 · 各自独立浏览器实例 · 预热后计数）===`)
console.log(`样张 ${samples.length} 张：${samples.map(s => s.split('/').pop().slice(0, 20)).join(' → ')}`)

const sessionA = await openSession('A', urlA)
const sessionB = await openSession('B', urlB)
if (!sessionA || !sessionB) {
  console.log('\n⚠ 有一侧打不开，无法对比')
  process.exit(1)
}

const warmup = async session => {
  const started = Date.now()
  const result = await runRound(session)
  console.log(`  ${session.label} 预热轮（不计入）：${((Date.now() - started) / 1000).toFixed(1)}s ｜ ${result.perSample.map(ms => (ms / 1000).toFixed(1) + 's').join(' ')}`)
}
console.log('\n--- 预热（让模型下载与初始化落在计数之外）---')
await warmup(sessionA)
await warmup(sessionB)

console.log(`\n--- 交替计数 ${REPEAT} 轮 ---`)
const roundsA = []
const roundsB = []
for (let round = 1; round <= REPEAT; round++) {
  const ra = await runRound(sessionA)
  roundsA.push(ra)
  const rb = await runRound(sessionB)
  roundsB.push(rb)
  const fmt = r => `${r.perSample.map(ms => (ms / 1000).toFixed(1)).join('/')}s 墙钟${(r.wallMs / 1000).toFixed(1)}s 长任务${r.longCount}个/${r.longTotal}ms`
  console.log(`  第 ${round}/${REPEAT} 轮`)
  console.log(`    A: ${fmt(ra)}`)
  console.log(`    B: ${fmt(rb)}`)
}

const a = summarize(sessionA, roundsA)
const b = summarize(sessionB, roundsB)

const dump = s => {
  console.log(`\n=== ${s.label} 汇总（${REPEAT} 轮 × ${samples.length} 张）===`)
  console.log(`  单张耗时  avg ${s.perSample.avg} ms ｜ p50 ${s.perSample.p50} ｜ p95 ${s.perSample.p95} ｜ p99 ${s.perSample.p99} ｜ max ${s.perSample.max}`)
  console.log(`  心跳间隔  avg ${s.gap.avg} ms ｜ p50 ${s.gap.p50} ｜ p95 ${s.gap.p95} ｜ p99 ${s.gap.p99} ｜ max ${s.gap.max}（${s.gap.count} 次）`)
  console.log(`  长任务    ${s.long.avgCount} 个/轮 ｜ 累计 ${s.long.avgTotal} ms/轮 ｜ 最长 ${s.long.max} ms`)
  console.log(`  整批墙钟  avg ${(s.wall.avg / 1000).toFixed(1)}s ｜ p50 ${(s.wall.p50 / 1000).toFixed(1)}s ｜ max ${(s.wall.max / 1000).toFixed(1)}s`)
  console.log(`  吞吐量    ${s.throughput.toFixed(1)} 张/分钟 ｜ 页面异常 ${s.errors}`)
}
dump(a)
dump(b)

const line = (name, va, vb) => `  ${name.padEnd(24)}${String(va).padStart(16)}${String(vb).padStart(16)}`
console.log('\n=== A / B 汇总 ===')
console.log('  ' + '指标'.padEnd(24) + 'A'.padStart(16) + 'B'.padStart(16))
console.log(line('打开 + 重载 (ms)', a.openMs, b.openMs))
console.log(line('单张 avg (ms)', a.perSample.avg, b.perSample.avg))
console.log(line('单张 p95 (ms)', a.perSample.p95, b.perSample.p95))
console.log(line('单张 max (ms)', a.perSample.max, b.perSample.max))
console.log(line('整批墙钟 avg (s)', (a.wall.avg / 1000).toFixed(1), (b.wall.avg / 1000).toFixed(1)))
console.log(line('吞吐量 (张/分钟)', a.throughput.toFixed(1), b.throughput.toFixed(1)))
console.log(line('心跳 avg (ms)', a.gap.avg, b.gap.avg))
console.log(line('心跳 p50 (ms)', a.gap.p50, b.gap.p50))
console.log(line('心跳 p95 (ms)', a.gap.p95, b.gap.p95))
console.log(line('心跳 p99 (ms)', a.gap.p99, b.gap.p99))
console.log(line('长任务 个数/轮', a.long.avgCount, b.long.avgCount))
console.log(line('长任务 累计 ms/轮', a.long.avgTotal, b.long.avgTotal))
console.log(line('长任务 最长 ms', a.long.max, b.long.max))
console.log(line('页面异常', a.errors, b.errors))
console.log('\n注：读数只作对照，不设通过阈值。报告前先跑 `git diff --stat <对照版> <当前版>`')
console.log('    确认两者只差被测的那一个变量，并把这条依据一并写进结论。')

await sessionA.browser.close()
await sessionB.browser.close()
