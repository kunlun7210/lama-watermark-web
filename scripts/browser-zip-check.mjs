import { mkdir, readdir, stat } from 'node:fs/promises'

const port = Number(process.env.CDP_PORT || 9223)
const targetPrefix = process.env.TEST_URL_PREFIX || 'http://localhost:5173'
const downloadPath = `/private/tmp/lama-zip-${Date.now()}`
await mkdir(downloadPath, { recursive: true })
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
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  if (message.error) waiter.reject(new Error(message.error.message))
  else waiter.resolve(message.result)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath, eventsEnabled: true })
await send('Runtime.evaluate', {
  expression: `document.querySelector('#save-all').click(); true`,
  awaitPromise: true,
  returnByValue: true,
})
let archive = null
for (let attempt = 0; attempt < 120; attempt++) {
  const files = await readdir(downloadPath)
  const candidate = files.find(file => file.endsWith('.zip'))
  if (candidate) {
    const absolute = `${downloadPath}/${candidate}`
    const details = await stat(absolute)
    if (details.size > 0) { archive = absolute; break }
  }
  await new Promise(resolve => setTimeout(resolve, 500))
}
socket.close()
if (!archive) throw new Error('ZIP download did not finish')
console.log(archive)
