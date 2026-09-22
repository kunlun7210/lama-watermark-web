import assert from 'node:assert/strict'
import { readFile, unlink, writeFile } from 'node:fs/promises'

const port = Number(process.env.CDP_PORT || 9223)
const targetPrefix = process.env.TEST_URL_PREFIX || 'http://localhost:4173'
const currentHtml = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8')
const legacyEntries = [
  { script: 'index-DiAJy31j.js', style: 'index-BlVSS6-9.css' },
  { script: 'index-BR3uS04e.js', style: 'index-BtL7aLdA.css' },
  { script: 'index-LGdPcOC7.js', style: 'index-BtL7aLdA.css' },
]

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
const results = []
for (let index = 0; index < legacyEntries.length; index++) {
  const legacyEntry = legacyEntries[index]
  const fixturePath = new URL(`../dist/stale-entry-check-${index}.html`, import.meta.url)
  const fixtureUrl = `${targetPrefix}/stale-entry-check-${index}.html`
  const staleHtml = currentHtml
    .replace(/\.\/assets\/app\.js\?v=\d+/, `./assets/${legacyEntry.script}`)
    .replace(/\.\/assets\/app\.css\?v=\d+/, `./assets/${legacyEntry.style}`)
  await writeFile(fixturePath, staleHtml)
  await evaluate(`location.href = ${JSON.stringify(fixtureUrl)}; true`)
  let result = null
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      result = await evaluate(`(() => ({
        ready: document.readyState,
        url: location.href,
        version: document.querySelector('#app-version')?.textContent || '',
        status: document.querySelector('#status')?.textContent || '',
        resources: performance.getEntriesByType('resource').map(entry => entry.name),
      }))()`)
    } catch { /* 导航中执行上下文会短暂失效 */ }
    if (result?.ready === 'complete' && /^v\d+\.\d+\.\d+ · \d{4}\.\d{2}\.\d{2}$/.test(result.version)) break
    await sleep(250)
  }
  await unlink(fixturePath).catch(() => {})
  assert.ok(result, `${legacyEntry.script} stale HTML did not initialize`)
  assert.match(result.url, /[?&]app-build=\d{14}/)
  assert.match(result.version, /^v\d+\.\d+\.\d+ · \d{4}\.\d{2}\.\d{2}$/)
  assert.ok(result.resources.some(url => url.includes(`/assets/${legacyEntry.script}`)))
  assert.ok(result.resources.some(url => url.includes('/assets/app.js?v=')))
  results.push({ legacyEntry: legacyEntry.script, ...result })
}

socket.close()
assert.deepEqual(errors, [])
console.log(JSON.stringify(results, null, 2))
