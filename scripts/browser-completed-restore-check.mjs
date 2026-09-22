const port = Number(process.env.CDP_PORT || 9223)
const targetPrefix = process.env.TEST_URL_PREFIX || 'http://localhost:5173'
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = targets.find(item => item.type === 'page' && item.url.startsWith(targetPrefix))
if (!target) throw new Error(`No page found for ${targetPrefix}`)

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let nextId = 1
const pending = new Map()
const errors = []
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  } else if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
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
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

await send('Runtime.enable')
await send('Page.enable')
const before = await evaluate(`({
  queue: document.querySelectorAll('#queue > li').length,
  results: document.querySelectorAll('#queue .q-actions button').length,
})`)
if (!before.queue || before.results !== before.queue) {
  throw new Error(`需要一个已全部完成的恢复批次：${JSON.stringify(before)}`)
}
await send('Page.reload', { ignoreCache: false })

let restored = null
for (let attempt = 0; attempt < 240; attempt++) {
  try {
    restored = await evaluate(`(() => ({
      ready: document.readyState,
      queue: document.querySelectorAll('#queue > li').length,
      results: document.querySelectorAll('#queue .q-actions button').length,
      running: !document.querySelector('#stop')?.hidden,
      status: document.querySelector('#status')?.textContent || '',
    }))()`)
  } catch { /* reload 中执行上下文会失效 */ }
  if (restored?.ready === 'complete' && restored.queue === before.queue && restored.results === before.queue && /^已恢复/.test(restored.status)) break
  await sleep(250)
}
await sleep(3000)
const after = await evaluate(`(() => ({
  status: document.querySelector('#status')?.textContent || '',
  running: !document.querySelector('#stop')?.hidden,
  modelDownloads: performance.getEntriesByType('resource')
    .map(entry => entry.name)
    .filter(name => name.includes('lama.part.') || name.split('?')[0].endsWith('.onnx')),
}))()`)
socket.close()
console.log(JSON.stringify({ before, restored, after, browserErrors: errors }, null, 2))
if (!restored || restored.results !== before.queue || after.running || after.modelDownloads.length || errors.length) {
  throw new Error('已完成批次恢复不应初始化或下载模型')
}
