/**
 * 批量处理 + 刷新恢复的端到端验收（针对本仓库的恢复语义）。
 *
 * 用法：
 *   TEST_URL_PREFIX=http://localhost:5173 CDP_PORT=9223 \
 *     node scripts/browser-batch-test.mjs "/path/to/gemini-images" [imageCount=20]
 *
 * 阶段 A：选 N 张图 → 跑批 → 统计 已处理 / 保持原图 / 失败，并检查状态区只显示
 *         「识别结果」「总耗时」两格。
 * 阶段 B：单独选 3 张、整批跑完后刷新页面，断言恢复到的条目数、已完成数、
 *         缩略图、预览画布、选图信息提示都回到刷新前的状态。
 *         本仓库自 v0.11.2 起把处理结果连同原图一起持久化，所以"已完成"必须被还原，
 *         而不是回到待处理。三个辅助字段（thumbCount / doneTexts / previewPainted）
 *         就是用来区分"状态标记回来了"和"结果数据真的回来了"。
 * 阶段 C：清空列表后刷新，断言不再恢复（回归「清空」这条路径没被结果持久化破坏）。
 */
import { writeFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

const root = process.argv[2]
const wanted = Number(process.argv[3] || 20)
const port = Number(process.env.CDP_PORT || 9223)
const targetPrefix = process.env.TEST_URL_PREFIX || 'http://localhost:5173'
if (!root) throw new Error('Usage: node scripts/browser-batch-test.mjs /absolute/test-set [count]')

async function filesBelow(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await filesBelow(absolute))
    else if (/\.(png|jpe?g|webp)$/i.test(entry.name)) output.push(absolute)
  }
  return output.sort()
}

const all = await filesBelow(root)
const selected = all.slice(0, wanted)
const phaseB = all.slice(0, 3)
if (selected.length < wanted) throw new Error(`只有 ${selected.length} 张可用图片`)

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = targets.find(item => item.type === 'page' && item.url.startsWith(targetPrefix))
if (!target) throw new Error(`没有找到 ${targetPrefix} 的页面`)

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let nextId = 1
const pending = new Map()
const browserErrors = []
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
    browserErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    browserErrors.push(message.params.args.map(arg => arg.value || arg.description).join(' '))
  }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(read, predicate, timeoutMs, label) {
  const started = Date.now()
  let value
  while (Date.now() - started < timeoutMs) {
    value = await read()
    if (predicate(value)) return value
    await sleep(1000)
  }
  throw new Error(`${label} 超时；最后一次取值: ${JSON.stringify(value)}`)
}

const stateExpression = `(() => {
  const items = [...document.querySelectorAll('#queue > li')]
  const text = node => (node?.textContent || '').trim()
  return {
    ready: document.readyState,
    queue: items.length,
    done: items.filter(li => li.classList.contains('done')).length,
    failed: items.filter(li => li.classList.contains('failed')).length,
    unchanged: items.filter(li => /未识别水印/.test(text(li.querySelector('.q-state')))).length,
    pending: items.filter(li => /等待处理/.test(text(li.querySelector('.q-state')))).length,
    status: text(document.querySelector('#status')),
    summary: text(document.querySelector('#queue-summary')),
    selectedName: text(document.querySelector('#selected-name')),
    running: !document.querySelector('#stop')?.hidden,
    runDisabled: document.querySelector('#run-batch')?.disabled,
    isolated: crossOriginIsolated,
    // 结果是否真的恢复回来了，靠这三个字段判定（光看状态不够）：
    // 缩略图只可能来自「结果 blob 重算」，q-state 文本里的 provider/区域/耗时
    // 只可能来自结果记录，预览画布非透明说明结果确实画上去了。
    thumbCount: items.filter(li => /^blob:/.test(li.querySelector('img')?.getAttribute('src') || '')).length,
    doneTexts: items.filter(li => /已去除/.test(text(li.querySelector('.q-state')))).length,
    previewPainted: (() => {
      const canvas = document.querySelector('#result')
      if (!canvas?.width) return false
      try {
        // 只取中心一个像素：整幅 getImageData 在大图上很慢
        const data = canvas.getContext('2d')
          .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
        return data[3] > 0
      } catch { return null }
    })(),
  }
})()`
const readState = () => evaluate(stateExpression)

async function clearQueue() {
  await evaluate(`(() => {
    const clear = document.querySelector('#clear')
    if (clear && !clear.hidden) clear.click()
    return true
  })()`)
  await waitFor(readState, value => value.queue === 0, 60000, '清空队列')
}

async function setFiles(files) {
  const documentNode = await send('DOM.getDocument', { depth: 1 })
  const input = await send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#file-input' })
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files })
}

await send('Runtime.enable')
await send('DOM.enable')
await send('Page.enable')
await waitFor(readState, value => value.ready === 'complete', 60000, '页面就绪')

/* ---------- 阶段 A：批量处理 ---------- */
console.log('=== 阶段 A：批量处理 ' + selected.length + ' 张 ===')
await clearQueue()
await setFiles(selected)
const picked = await waitFor(
  readState,
  value => value.queue === selected.length && !value.runDisabled,
  180000,
  '选择图片',
)
console.log('  已选入: queue=' + picked.queue + ' 隔离=' + picked.isolated + ' 可运行=' + !picked.runDisabled)

await evaluate(`document.querySelector('#run-batch').click(); true`)
const finished = await waitFor(
  readState,
  value => !value.running && value.done + value.unchanged + value.failed === selected.length,
  2400000,
  '批量处理完成',
)
console.log('  完成: ' + JSON.stringify({
  已处理: finished.done,
  保持原图: finished.unchanged,
  失败: finished.failed,
  状态: finished.status,
  汇总: finished.summary,
}))

// 状态区只应显示「识别结果」+「总耗时」
const metrics = await evaluate(`(() => {
  const boxes = [...document.querySelectorAll('#metrics > div')]
  return {
    格数: boxes.length,
    项目: boxes.map(box => ({
      名称: (box.querySelector('dt')?.textContent || '').trim(),
      值: (box.querySelector('dd')?.textContent || '').trim(),
    })),
    innerText: (document.querySelector('#metrics')?.innerText || '').trim(),
  }
})()`)
console.log('  状态区: ' + JSON.stringify(metrics))

/* ---------- 阶段 B：刷新恢复（强断言，不只是打印） ---------- */
console.log('')
console.log('=== 阶段 B：刷新后恢复已完成结果 ===')
await clearQueue()
await setFiles(phaseB)
await waitFor(readState, value => value.queue === phaseB.length && !value.runDisabled, 180000, '阶段B 选择图片')
await evaluate(`document.querySelector('#run-batch').click(); true`)
// 必须等整批跑完再刷新：跑一半就刷新会打断在途那张，done 数不可预期、断言失去基准。
const beforeReload = await waitFor(
  readState,
  value => !value.running && value.done + value.unchanged + value.failed === phaseB.length,
  1800000,
  '阶段B 批量处理完成',
)
console.log('  刷新前: ' + JSON.stringify({
  queue: beforeReload.queue,
  done: beforeReload.done,
  unchanged: beforeReload.unchanged,
  failed: beforeReload.failed,
  缩略图: beforeReload.thumbCount,
}))

await send('Page.reload', { ignoreCache: false })
await waitFor(readState, value => value.ready === 'complete', 60000, '页面重载')
const afterReload = await waitFor(readState, value => value.queue > 0, 120000, '恢复上次的图片')
console.log('  刷新后: ' + JSON.stringify({
  queue: afterReload.queue,
  done: afterReload.done,
  unchanged: afterReload.unchanged,
  pending: afterReload.pending,
  failed: afterReload.failed,
  缩略图: afterReload.thumbCount,
  已去除文本: afterReload.doneTexts,
  预览已画: afterReload.previewPainted,
  选图信息: afterReload.selectedName,
  状态: afterReload.status,
}))

const checks = [
  ['刷新后条目数不变', afterReload.queue === beforeReload.queue],
  [`已完成数被恢复（${beforeReload.done} 张）`, afterReload.done === beforeReload.done && afterReload.done >= 1],
  ['保持原图数被恢复', afterReload.unchanged === beforeReload.unchanged],
  // 失败项不落盘结果，恢复后回到「等待处理」是设计使然（本来就该重跑），
  // 所以期望值不是 0 而是「等于刷新前的失败数」。
  ['除失败项外没有条目被打回待处理', afterReload.pending === beforeReload.failed],
  ['缩略图已从结果重建', afterReload.thumbCount === afterReload.done + afterReload.unchanged],
  ['队列描述含「已去除」（provider/区域/耗时都恢复）', afterReload.doneTexts === afterReload.done],
  ['预览区已画回结果', afterReload.previewPainted === true],
  // 断言「选图信息」那一行，而不是状态行：状态行紧接着会被模型预热的
  // 「正在初始化 INT8 · 62MB」覆盖，测它就等于测一个用户看不见的瞬间。
  ['选图信息行提示已有结果', /其中 \d+ 张已有结果/.test(afterReload.selectedName)],
]
console.log('  --- 断言 ---')
let failedChecks = 0
for (const [label, ok] of checks) {
  console.log('    ' + (ok ? '✓' : '✗') + ' ' + label)
  if (!ok) failedChecks++
}

/* ---------- 阶段 C：清空后不应再恢复 ---------- */
console.log('')
console.log('=== 阶段 C：清空列表后刷新不应再恢复 ===')
await clearQueue()
await send('Page.reload', { ignoreCache: false })
await waitFor(readState, value => value.ready === 'complete', 60000, '页面重载')
await sleep(3000) // 留出恢复流程的时间：若它错误地恢复了，这里就能看见
const afterClear = await readState()
const clearOk = afterClear.queue === 0
console.log('  ' + (clearOk ? '✓' : '✗') + ` 清空后刷新仍为空列表（queue=${afterClear.queue}）`)
if (!clearOk) failedChecks++

console.log('')
console.log('  浏览器错误: ' + JSON.stringify(browserErrors))

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
await writeFile('/tmp/gemini-batch-result.png', Buffer.from(shot.data, 'base64'))
console.log('  截图: /tmp/gemini-batch-result.png')
socket.close()
if (failedChecks) throw new Error('刷新恢复验收有 ' + failedChecks + ' 项未通过')
if (browserErrors.length) throw new Error('存在浏览器错误')
