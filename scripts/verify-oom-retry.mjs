import { isOutOfMemory, runWithOomFallback } from '../src/oom-retry.js'
import { readFile } from 'node:fs/promises'

let threads = 4
const attempts = []
const rebuilds = []
const result = await runWithOomFallback({
  run: async () => {
    attempts.push(threads)
    if (attempts.length < 3) throw new Error('WebAssembly allocation failed: out of memory')
    return 'ok'
  },
  getThreads: () => threads,
  setThreads: value => { threads = value },
  rebuild: async value => { rebuilds.push(value) },
})
if (result !== 'ok' || attempts.join(',') !== '4,2,1' || rebuilds.join(',') !== '2,1') {
  throw new Error(`OOM 动态重试顺序错误：${JSON.stringify({ result, attempts, rebuilds })}`)
}

for (const message of ['RangeError: invalid array length', 'no available backend found', '图片解码失败']) {
  if (isOutOfMemory(new Error(message))) throw new Error(`普通错误被误判为 OOM：${message}`)
}

let rebuilt = false
await runWithOomFallback({
  run: async () => { throw new Error('no available backend found') },
  getThreads: () => 4,
  setThreads: () => {},
  rebuild: async () => { rebuilt = true },
}).then(() => { throw new Error('兼容性错误不应成功') }).catch(error => {
  if (!/no available backend/.test(error.message)) throw error
})
if (rebuilt) throw new Error('兼容性错误不应触发线程降级')

const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8')
if (!mainSource.includes('runWithOomFallback({')) throw new Error('主批处理流程没有接入 OOM 重建重试')
if (/RangeError\|no available backend/.test(mainSource)) throw new Error('主流程仍保留过宽的旧 OOM 判断')

console.log('oom: real OOM retries 4→2→1; unrelated errors fail fast')
