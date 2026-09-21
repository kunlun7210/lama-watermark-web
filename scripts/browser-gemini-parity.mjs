/**
 * Gemini 浏览器侧 parity：逐张比对识别状态、处理方法、坐标、模板尺寸、Alpha 增益与动作哈希。
 *
 * ⚠️ 基线里 `clean_*` 样本必须为 `status: "not-found"` + `actionSha256: null`。
 * 自 v0.15.0 起，反向 Alpha 残差超过 `GEMINI_FALLBACK_MAX_RESIDUAL`(0.35) 就直接判 not-found、
 * **不生成掩膜** —— 干净图偶然命中轮廓（如 `clean_gemini_sample_2.png` 残差高达 0.965）
 * 因此不会被送进 LaMa 擦掉。没有掩膜自然没有动作哈希，这是正确行为，不是缺字段。
 *
 * 反过来：若某个 `clean_*` 条目出现 `needs-inpaint`，说明**基线陈旧或残差门槛被改坏了**，
 * 别为了让脚本变绿去重录基线 —— 先查 `src/gemini.js` 的 `geminiFallbackIsValid`。
 */
import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const geminiRoot = process.argv[2]
const expectedPath = process.argv[3]
const negativeRoot = process.argv[4]
const port = Number(process.env.CDP_PORT || 9223)
const targetPrefix = process.env.TEST_URL_PREFIX || 'http://localhost:5173'
if (!geminiRoot || !expectedPath) {
  throw new Error('Usage: node scripts/browser-gemini-parity.mjs /gemini-images /expected.json [/negative-images]')
}

async function filesBelow(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await filesBelow(absolute))
    else if (/\.(png|jpe?g|webp)$/i.test(entry.name)) output.push(absolute)
  }
  return output.sort()
}

const expected = JSON.parse(await readFile(expectedPath, 'utf8'))
const positiveFiles = (await filesBelow(geminiRoot)).filter(file => expected[path.basename(file)])
const negativeFiles = negativeRoot
  ? (await filesBelow(negativeRoot)).filter(file => {
      const description = execFileSync('file', ['-b', file], { encoding: 'utf8' })
      return !/HEIF|HEIC/i.test(description)
    })
  : []

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

await send('Runtime.enable')
await send('DOM.enable')
await evaluate(`(() => {
  document.querySelector('#gemini-test-input')?.remove()
  const input = document.createElement('input')
  input.type = 'file'
  input.id = 'gemini-test-input'
  input.hidden = true
  document.body.append(input)
  return true
})()`)
const documentNode = await send('DOM.getDocument', { depth: 1 })
const inputNode = await send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#gemini-test-input' })

async function inspect(file) {
  await send('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [file] })
  return evaluate(`(async () => {
    const file = document.querySelector('#gemini-test-input').files[0]
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(bitmap, 0, 0)
    bitmap.close?.()
    const image = context.getImageData(0, 0, canvas.width, canvas.height)
    const { processGemini } = await import('/src/gemini.js')
    const result = processGemini(image.data, canvas.width, canvas.height)
    let actionSha256 = null
    if (result.status === 'cleaned') {
      const rgb = new Uint8Array(result.size * result.size * 3)
      for (let source = 0, target = 0; source < result.patch.length; source += 4) {
        rgb[target++] = result.patch[source]
        rgb[target++] = result.patch[source + 1]
        rgb[target++] = result.patch[source + 2]
      }
      const digest = await crypto.subtle.digest('SHA-256', rgb)
      actionSha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
    } else if (result.status === 'needs-inpaint') {
      const digest = await crypto.subtle.digest('SHA-256', result.region.mask)
      actionSha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
    }
    return {
      status: result.status,
      method: result.method,
      x: result.x ?? null,
      y: result.y ?? null,
      size: result.size ?? null,
      margin: result.margin ?? null,
      alphaGain: result.alphaGain ?? null,
      alphaResidual: result.alphaResidual ?? null,
      confidence: result.confidence ?? null,
      actionSha256,
    }
  })()`)
}

const mismatches = []
for (const file of positiveFiles) {
  const name = path.basename(file)
  const actual = await inspect(file)
  const wanted = expected[name]
  const exact = ['status', 'method', 'x', 'y', 'size', 'actionSha256']
  const wrong = exact.some(key => actual[key] !== wanted[key])
    || (wanted.alphaGain !== null && Math.abs(actual.alphaGain - wanted.alphaGain) > 0.021)
  if (wrong) mismatches.push({ name, wanted, actual })
}

const falsePositives = []
let negativeDecoded = 0
for (const file of negativeFiles) {
  try {
    const actual = await inspect(file)
    negativeDecoded++
    if (actual.status !== 'not-found') falsePositives.push({ file, actual })
  } catch (error) {
    if (!/decode|image|bitmap|source/i.test(String(error))) throw error
  }
}

console.log(JSON.stringify({
  positives: positiveFiles.length,
  mismatches,
  negatives: negativeDecoded,
  falsePositives,
  browserErrors: errors,
}, null, 2))
socket.close()
if (mismatches.length || falsePositives.length || errors.length) throw new Error('Gemini browser parity failed')
