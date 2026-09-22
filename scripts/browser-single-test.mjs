const file = process.argv[2]
const port = Number(process.env.CDP_PORT || 9223)
const targetPrefix = process.env.TEST_URL_PREFIX || 'http://localhost:5173'
const model = process.env.MODEL || 'fp32'
if (!file) throw new Error('Usage: node scripts/browser-single-test.mjs /absolute/image')
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
  } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails
    const description = detail.exception?.description || detail.text
    throw new Error(description)
  }
  return result.result.value
}
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const readState = () => evaluate(`(() => ({
  queue: document.querySelectorAll('#queue > li').length,
  readyResults: document.querySelectorAll('#queue .q-actions button').length,
  failed: document.querySelectorAll('#queue > li.failed').length,
  status: document.querySelector('#status')?.textContent || '',
  detail: document.querySelector('#progress-label')?.textContent || '',
  running: !document.querySelector('#stop')?.hidden,
  runDisabled: document.querySelector('#run-batch')?.disabled,
  model: document.querySelector('input[name=model]:checked')?.value,
  isolated: crossOriginIsolated,
  version: document.querySelector('#app-version')?.textContent || '',
  runtimeBarExists: !!document.querySelector('#runtime-note'),
  modelMoreOpen: !!document.querySelector('.model-more')?.open,
  previewEmpty: document.querySelector('#preview-grid')?.dataset.empty || '',
  canvasesHidden: [...document.querySelectorAll('#preview-grid canvas')]
    .every(canvas => getComputedStyle(canvas).display === 'none'),
  metricsHidden: !!document.querySelector('#metrics')?.hidden,
  metricLabels: [...document.querySelectorAll('#metrics dt')].map(item => item.textContent),
  metricValues: [...document.querySelectorAll('#metrics dd')].map(item => item.textContent),
  downloadHosts: [...new Set(performance.getEntriesByType('resource')
    .map(entry => { try { return new URL(entry.name).host } catch { return '' } })
    .filter(host => ['jsdelivr', 'huggingface', 'github.io', 'hf.co'].some(name => host.includes(name))))],
  modelChunkHosts: [...new Set(performance.getEntriesByType('resource')
    .filter(entry => entry.name.includes('lama.part.') || (entry.name.includes('/resolve/') && entry.name.endsWith('.onnx')))
    .map(entry => new URL(entry.name).host))],
}))()`)
async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  let value
  while (Date.now() - started < timeoutMs) {
    value = await readState()
    if (predicate(value)) return value
    await sleep(1000)
  }
  throw new Error(`${label} timed out: ${JSON.stringify(value)}`)
}

await send('Runtime.enable')
await waitFor(value => value.isolated, 30000, 'cross-origin isolation')
const initialState = await readState()
if (initialState.queue > 0) {
  await evaluate(`document.querySelector('#clear').click(); true`)
  await waitFor(value => value.queue === 0 && /等待选择图片/.test(value.status), 30000, 'clear prior batch')
}
const emptyState = await readState()
if (emptyState.runtimeBarExists || emptyState.previewEmpty !== 'true' || !emptyState.canvasesHidden || !emptyState.metricsHidden) {
  throw new Error(`empty-state UI validation failed: ${JSON.stringify(emptyState)}`)
}
await evaluate(`document.querySelector('input[value=${model}]').click(); true`)
const documentNode = await send('DOM.getDocument', { depth: 1 })
const input = await send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#file-input' })
await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] })
await waitFor(value => value.queue === 1 && !value.runDisabled && value.model === model, 120000, `select ${model} image`)
await evaluate(`document.querySelector('#run-batch').click(); true`)
const result = await waitFor(
  value => !value.running && /批量处理完成/.test(value.status) && value.readyResults + value.failed === 1,
  900000,
  `${model} inference`,
)
console.log(JSON.stringify(result))
console.log(JSON.stringify(errors))
socket.close()
const expectedMetricLabels = ['水印类型', '总耗时']
if (result.failed || errors.length || result.previewEmpty !== 'false' || result.runtimeBarExists
  || JSON.stringify(result.metricLabels) !== JSON.stringify(expectedMetricLabels)) {
  throw new Error(`${model} browser validation failed`)
}
