/**
 * 线程策略校验（纯 Node，不需要浏览器）。
 *
 * 两件事：
 * 1) 策略函数本身的取值；
 * 2) **架构约束也变成可执行断言** —— 降级只能存在页面内存里，
 *    且必须清掉旧版遗留的持久值。靠注释约束不住，靠断言才行。
 */
import { readFile } from 'node:fs/promises'
import { chooseThreadCount, lowerThreadCount, threadCeiling } from '../src/thread-policy.js'

const cases = [
  [threadCeiling(true, 8), 4, '隔离环境最多使用 4 线程'],
  [threadCeiling(true, 2), 2, '低核心设备不超过硬件并发数'],
  [threadCeiling(true, 0), 2, '拿不到核心数时按 2 估算'],
  [threadCeiling(false, 8), 1, '非隔离环境只能使用 1 线程'],
  [chooseThreadCount(true, 8, 0), 4, '新页面恢复自动线程数'],
  [chooseThreadCount(true, 8, 2), 2, '当前页面遵守 2 线程保护上限'],
  [chooseThreadCount(true, 8, 1), 1, '当前页面遵守 1 线程保护上限'],
  [chooseThreadCount(true, 8, 3), 3, '非 2 的幂上限同样生效'],
  [chooseThreadCount(true, 8, 99), 4, '越界上限被 ceiling 收住'],
  [chooseThreadCount(false, 8, 4), 1, '运行时上限不能突破浏览器能力'],
  [chooseThreadCount(true, 2, 4), 2, '低核心设备上 4 线程上限也被收住'],
  [lowerThreadCount(4), 2, '第一次 OOM 从 4 降为 2'],
  [lowerThreadCount(3), 2, '非 4 的起点同样先降到 2'],
  [lowerThreadCount(2), 1, '第二次 OOM 从 2 降为 1'],
  [lowerThreadCount(1), 1, '已是最低时保持 1，不会降到 0'],
]

const failed = []
for (const [actual, expected, label] of cases) {
  if (actual !== expected) failed.push(`${label}：期望 ${expected}，实际 ${actual}`)
}

const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8')
if (/localStorage\.(?:getItem|setItem)\(LEGACY_THREAD_PREF_KEY/.test(mainSource)) {
  failed.push('OOM 线程上限不能继续从 localStorage 读取或写入')
}
if (!mainSource.includes('localStorage.removeItem(LEGACY_THREAD_PREF_KEY)')) {
  failed.push('新版必须清除旧版本遗留的永久线程上限')
}

if (failed.length) {
  console.error('线程策略校验失败：')
  for (const message of failed) console.error('  ✗ ' + message)
  process.exit(1)
}
console.log(`threads: runtime downgrade and automatic recovery verified（${cases.length} 项 + 2 项源码约束）`)
