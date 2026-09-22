import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const port = Number(process.env.CDP_PORT || 9223)
const targetPrefix = process.env.TEST_URL_PREFIX || 'http://localhost:4173'
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

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function waitFor(read, predicate, timeoutMs, label) {
  const started = Date.now()
  let value
  while (Date.now() - started < timeoutMs) {
    try { value = await read() } catch { /* reload 中执行上下文会短暂失效 */ }
    if (value && predicate(value)) return value
    await sleep(250)
  }
  throw new Error(`${label} timed out; last value: ${JSON.stringify(value)}`)
}

const pageState = () => evaluate(`(() => ({
  ready: document.readyState,
  queue: document.querySelectorAll('#queue > li').length,
  results: document.querySelectorAll('#queue .q-actions button').length,
  failed: document.querySelectorAll('#queue > li.failed').length,
  status: document.querySelector('#status')?.textContent || '',
  selected: document.querySelector('#selected-name')?.textContent || '',
  runDisabled: document.querySelector('#run-batch')?.disabled,
}))()`)

const databaseState = () => evaluate(`(async () => {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('lama-iphone-poc', 2)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const batch = await new Promise((resolve, reject) => {
      const request = database.transaction('images', 'readonly').objectStore('images').get('batch')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const results = await new Promise((resolve, reject) => {
      const request = database.transaction('results', 'readonly').objectStore('results').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const hashes = []
    for (const result of results) {
      const bytes = await result.outputBlob.arrayBuffer()
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      hashes.push({
        id: result.id,
        size: result.outputBlob.size,
        hash: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''),
        status: result.status,
      })
    }
    return { batch: batch?.files?.length || 0, results: results.length, hashes }
  } finally {
    database.close()
  }
})()`)

async function clearPage() {
  await evaluate(`(() => {
    const button = document.querySelector('#clear')
    if (button && !button.hidden) button.click()
    return true
  })()`)
  await waitFor(pageState, value => value.queue === 0, 30000, 'clear batch')
}

async function selectFiles(files) {
  const documentNode = await send('DOM.getDocument', { depth: 1 })
  const input = await send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#file-input' })
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files })
}

await send('Runtime.enable')
await send('DOM.enable')
await send('Page.enable')
await send('Network.enable')
await send('Network.setBlockedURLs', {
  urls: ['*cdn.jsdelivr.net*', '*huggingface.co*', '*kunlun7210.github.io/lama-watermark-web/*'],
})
await waitFor(pageState, value => value.ready === 'complete', 30000, 'page ready')
await clearPage()

const fixtureDirectory = await mkdtemp(join(tmpdir(), 'lama-boundary-'))
const jpegDataUrl = await evaluate(`(() => {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const context = canvas.getContext('2d')
  const image = context.createImageData(128, 128)
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const offset = (y * 128 + x) * 4
      image.data[offset] = (x * 3 + y) % 256
      image.data[offset + 1] = (x + y * 5) % 256
      image.data[offset + 2] = (x * 7 + y * 11) % 256
      image.data[offset + 3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  return canvas.toDataURL('image/jpeg', 0.91)
})()`)
const jpegBytes = Buffer.from(jpegDataUrl.split(',')[1], 'base64')
const expectedHash = createHash('sha256').update(jpegBytes).digest('hex')
const cleanFile = join(fixtureDirectory, 'clean-original.jpg')
const badFile = join(fixtureDirectory, 'bad-first.jpg')
await writeFile(cleanFile, jpegBytes)
await writeFile(badFile, 'not a decodable image')
const overflowFiles = []
for (let index = 0; index < 40; index++) {
  const file = join(fixtureDirectory, `overflow-${String(index).padStart(2, '0')}.jpg`)
  await writeFile(file, jpegBytes)
  overflowFiles.push(file)
}

// P2：未识别 JPEG 的结果必须和输入逐字节一致。
await selectFiles([cleanFile])
await waitFor(pageState, value => value.queue === 1 && !value.runDisabled, 30000, 'select clean JPEG')
await evaluate(`document.querySelector('#run-batch').click(); true`)
await waitFor(pageState, value => value.queue === 1 && value.results === 1 && /批量处理完成/.test(value.status), 60000, 'process clean JPEG')
const exactOriginal = await databaseState()
assert.equal(exactOriginal.batch, 1)
assert.equal(exactOriginal.results, 1)
assert.equal(exactOriginal.hashes[0].status, 'unchanged')
assert.equal(exactOriginal.hashes[0].size, jpegBytes.length)
assert.equal(exactOriginal.hashes[0].hash, expectedHash)

// P1：超限追加必须原子拒绝，队列和已完成结果都不能变化。
await selectFiles(overflowFiles)
const rejected = await waitFor(pageState, value => /无法追加/.test(value.selected), 30000, 'reject over-limit append')
assert.equal(rejected.queue, 1)
assert.equal(rejected.results, 1)
const afterOverflow = await databaseState()
assert.equal(afterOverflow.batch, 1)
assert.equal(afterOverflow.results, 1)
assert.equal(afterOverflow.hashes[0].hash, expectedHash)

// P1：首张损坏时，刷新仍要保留整批和第二张的有效结果。
await clearPage()
await selectFiles([badFile, cleanFile])
await waitFor(pageState, value => value.queue === 2 && !value.runDisabled, 30000, 'select corrupt + valid')
await evaluate(`document.querySelector('#run-batch').click(); true`)
await waitFor(pageState, value => value.queue === 2 && value.results === 1 && value.failed === 1 && /批量处理完成/.test(value.status), 60000, 'process corrupt + valid')
const beforeReload = await databaseState()
assert.equal(beforeReload.batch, 2)
assert.equal(beforeReload.results, 1)
await evaluate(`location.reload(); true`)
const restored = await waitFor(pageState, value => value.ready === 'complete' && value.queue === 2 && value.results === 1 && /^已恢复/.test(value.status), 60000, 'restore corrupt + valid')
const afterReload = await databaseState()
assert.equal(afterReload.batch, 2)
assert.equal(afterReload.results, 1)
assert.equal(afterReload.hashes[0].hash, expectedHash)

await clearPage()
socket.close()
console.log(JSON.stringify({ exactOriginal, rejected, afterOverflow, beforeReload, restored, afterReload, browserErrors }, null, 2))
const unexpectedErrors = browserErrors.filter(error => !error.includes('浏览器的图像解码器打不开这个文件'))
if (unexpectedErrors.length) throw new Error(`Unexpected browser console errors: ${unexpectedErrors.join('; ')}`)
