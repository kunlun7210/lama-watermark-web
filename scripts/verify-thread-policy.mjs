import { readFile } from 'node:fs/promises'
import { chooseThreadCount, lowerThreadCount, threadCeiling } from '../src/thread-policy.js'

const cases = [
  [threadCeiling(true, 8), 4, '隔离环境最多使用 4 线程'],
  [threadCeiling(true, 2), 2, '低核心设备不超过硬件并发数'],
  [threadCeiling(false, 8), 1, '非隔离环境只能使用 1 线程'],
  [chooseThreadCount(true, 8, 0), 4, '新页面恢复自动线程数'],
  [chooseThreadCount(true, 8, 2), 2, '当前页面遵守 2 线程保护上限'],
  [chooseThreadCount(true, 8, 1), 1, '当前页面遵守 1 线程保护上限'],
  [chooseThreadCount(false, 8, 4), 1, '运行时上限不能突破浏览器能力'],
  [lowerThreadCount(4), 2, '第一次 OOM 从 4 降为 2'],
  [lowerThreadCount(2), 1, '第二次 OOM 从 2 降为 1'],
]
for (const [actual, expected, label] of cases) {
  if (actual !== expected) throw new Error(`${label}：期望 ${expected}，实际 ${actual}`)
}

const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8')
if (/localStorage\.(?:getItem|setItem)\(LEGACY_THREAD_PREF_KEY/.test(mainSource)) {
  throw new Error('OOM 线程上限不能继续从 localStorage 读取或写入')
}
if (!mainSource.includes('localStorage.removeItem(LEGACY_THREAD_PREF_KEY)')) {
  throw new Error('新版必须清除旧版本遗留的永久线程上限')
}
console.log('threads: runtime downgrade and automatic recovery verified')
