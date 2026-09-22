import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

const root = process.argv[2]
const port = Number(process.env.CDP_PORT || 9223)
const targetPrefix = process.env.TEST_URL_PREFIX || 'http://localhost:5173'
if (!root) throw new Error('Usage: node scripts/browser-batch-test.mjs /absolute/test-set')

async function filesBelow(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await filesBelow(absolute))
    else if (/\.(png|jpe?g|webp)$/i.test(entry.name)) output.push(absolute)
  }
  return output
}

const byDirectory = new Map()
for (const file of await filesBelow(root)) {
  const description = execFileSync('file', ['-b', file], { encoding: 'utf8' })
  if (/HEIF|HEIC/i.test(description)) continue
  const directory = path.dirname(file)
  if (!byDirectory.has(directory)) byDirectory.set(directory, [])
  byDirectory.get(directory).push(file)
}
const buckets = [...byDirectory.values()].map(files => files.sort())
const selected = []
while (selected.length < 20 && buckets.some(bucket => bucket.length)) {
  for (const bucket of buckets) {
    if (bucket.length && selected.length < 20) selected.push(bucket.shift())
  }
}
if (selected.length < 20) throw new Error(`Only found ${selected.length} browser-decodable images`)

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
const consoleErrors = []
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
  if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text)
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map(arg => arg.value || arg.description).join(' '))
  }
})

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function waitFor(read, predicate, timeoutMs, label) {
  const started = Date.now()
  let value
  while (Date.now() - started < timeoutMs) {
    value = await read()
    if (predicate(value)) return value
    await sleep(1000)
  }
  throw new Error(`${label} timed out; last value: ${JSON.stringify(value)}`)
}

const stateExpression = `(() => ({
  ready: document.readyState,
  queue: document.querySelectorAll('#queue > li').length,
  done: document.querySelectorAll('#queue > li.done').length,
  readyResults: document.querySelectorAll('#queue .q-actions button').length,
  failed: document.querySelectorAll('#queue > li.failed').length,
  status: document.querySelector('#status')?.textContent || '',
  detail: document.querySelector('#progress-label')?.textContent || '',
  summary: document.querySelector('#queue-summary')?.textContent || '',
  running: !document.querySelector('#stop')?.hidden,
  runDisabled: document.querySelector('#run-batch')?.disabled,
  isolated: crossOriginIsolated,
}))()`
const readState = () => evaluate(stateExpression)

await send('Runtime.enable')
await send('DOM.enable')
await waitFor(readState, value => value.ready === 'complete', 30000, 'page ready')
await evaluate(`(() => {
  const clear = document.querySelector('#clear')
  if (clear && !clear.hidden && document.querySelector('#stop')?.hidden) clear.click()
  return true
})()`)
await waitFor(readState, value => value.queue === 0, 30000, 'clear previous batch')
const documentNode = await send('DOM.getDocument', { depth: 1 })
const input = await send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#file-input' })
await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: selected })

const selectedState = await waitFor(readState, value => value.queue === 20 && !value.runDisabled, 120000, 'select 20 images')
console.log('selected', JSON.stringify(selectedState))

await evaluate(`document.querySelector('#run-batch').click(); true`)
const partial = await waitFor(readState, value => value.readyResults >= 2, 420000, 'first two completed results')
console.log('before-reload', JSON.stringify(partial))

await send('Page.enable')
await send('Page.reload', { ignoreCache: false })
await waitFor(readState, value => value.ready === 'complete', 30000, 'page reload')
const restored = await waitFor(readState, value => value.queue === 20 && value.readyResults >= 2 && !value.runDisabled, 120000, 'restored batch')
console.log('restored', JSON.stringify(restored))

await evaluate(`document.querySelector('#run-batch').click(); true`)
const completed = await waitFor(
  readState,
  value => !value.running && /批量处理完成/.test(value.status) && value.readyResults + value.failed >= 20,
  900000,
  '20-image batch',
)
console.log('completed', JSON.stringify(completed))
console.log('console-errors', JSON.stringify(consoleErrors))
console.log('files', JSON.stringify(selected))
socket.close()

if (completed.failed) throw new Error(`${completed.failed} images failed`)
if (consoleErrors.length) throw new Error(`Browser console errors: ${consoleErrors.join('; ')}`)
