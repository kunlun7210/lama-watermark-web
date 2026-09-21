/**
 * 恢复行为验证：刷新恢复时，"该不该预热模型"两边都要验。
 *
 * 背景：恢复流程若复用了"选图流程"，会把"选完图立刻在后台准备模型"这个副作用一起继承 ——
 * 刷新一次就开始下载 62MB 或建一次 WASM 会话，而"整批都已完成"时用户只是回来看结果。
 * 但修的时候很容易**修过头**（把该预热的也一起跳过），所以必须双向验：
 *
 *   场景 A：整批都已完成 → 不该预热
 *   场景 B：还有待处理的图 → 应当照常预热
 *
 * 判据：页面初始化末尾会无条件打印一条「推理线程」；预热建好会话后会再打印一条。
 *   → A 只应有 1 条；B 应 ≥ 2 条。
 *
 * ⚠️ 用 Chrome 而不是 WebKit：无头 WebKit 下 IndexedDB 恢复不成功，
 *    探针会读到"恢复 0 项"，那是测试环境限制、不是产品行为，会得出假结论。
 *
 * 用法（需要样张至少 3 张：前两张用于前置批次，第三张用于场景 B）：
 *   node scripts/browser-restore-check.mjs <url> <样张1> <样张2> <样张3>
 */
import { chromium, devices } from 'playwright'

const url = process.argv[2]
const samples = process.argv.slice(3)
if (!url || samples.length < 3) {
  console.error('用法：node scripts/browser-restore-check.mjs <url> <样张1> <样张2> <样张3>')
  process.exit(2)
}
const [batchA, batchB, extra] = samples

const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({ ...devices['iPhone 15 Pro'] })
const page = await context.newPage()

const threadLogs = []
page.on('console', message => { if (message.text().includes('推理线程')) threadLogs.push(message.text()) })

const snapshot = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('#queue > li')]
  return {
    count: rows.length,
    states: rows.map(row => (row.querySelector('.q-state')?.textContent || '').trim().slice(0, 22)),
    downloadBarHidden: !!document.querySelector('#download-bar')?.hidden,
  }
})

const done = state => /已去除|未识别/.test(state)

await page.goto(url, { waitUntil: 'load', timeout: 180000 })
await page.reload({ waitUntil: 'load', timeout: 180000 })
await page.waitForTimeout(1500)

console.log('=== 前置：先把 2 张处理完 ===')
await page.setInputFiles('#file-input', [batchA, batchB])
await page.waitForTimeout(1500)
await page.click('#run-batch')
try {
  await page.waitForFunction(() => /批量处理完成/.test(document.querySelector('#status')?.textContent || ''), { timeout: 300000 })
} catch { console.log('  ⚠ 未在时限内完成') }
const before = await snapshot()
console.log(`  队列 ${before.count} 项 → ${JSON.stringify(before.states)}`)

// ---------- 场景 A：整批都已完成 ----------
threadLogs.length = 0
await page.reload({ waitUntil: 'load', timeout: 180000 })
await page.waitForTimeout(7000)
const stateA = await snapshot()
console.log('\n=== 场景 A：刷新恢复（整批都已完成）===')
console.log(`  队列 ${stateA.count} 项 → ${JSON.stringify(stateA.states)}`)

const restoredA = stateA.count === 2 && stateA.states.every(done)
if (!restoredA) {
  console.log('  ⚠ 恢复未成功（队列与预期不符），本场景无法判定 —— 不要据此下结论')
}
const checks = []
checks.push(['场景 A 恢复成功', restoredA])
checks.push(['场景 A 未预热模型（只有 1 条基线日志）', restoredA && threadLogs.length <= 1])
console.log(`  「推理线程」日志 ${threadLogs.length} 条 ；下载条隐藏 ${stateA.downloadBarHidden}`)

// ---------- 场景 B：还有一张未处理 ----------
threadLogs.length = 0
await page.setInputFiles('#file-input', extra)
await page.waitForTimeout(2500)
const beforeB = await snapshot()
console.log('\n=== 场景 B：刷新恢复（含 1 张未处理）===')
console.log(`  刷新前队列 ${beforeB.count} 项 → ${JSON.stringify(beforeB.states)}`)
await page.reload({ waitUntil: 'load', timeout: 180000 })
await page.waitForTimeout(7000)
const stateB = await snapshot()
const hasPending = stateB.states.some(state => !done(state))
console.log(`  队列 ${stateB.count} 项 → ${JSON.stringify(stateB.states)}`)
console.log(`  「推理线程」日志 ${threadLogs.length} 条`)
checks.push(['场景 B 仍存在待处理项', stateB.count === 3 && hasPending])
checks.push(['场景 B 照常预热模型（≥2 条日志）', stateB.count === 3 && hasPending && threadLogs.length >= 2])

console.log('\n=== 结果 ===')
let failed = 0
for (const [label, ok] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failed++
}

await browser.close()
console.log(failed ? `\n❌ ${failed} 项不符合预期` : '\n✅ 恢复行为符合预期（该跳过的跳过、该预热的预热）')
process.exit(failed ? 1 : 0)
