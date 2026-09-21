/**
 * 线程降级记忆的边界条件校验（纯 Node，不需要浏览器）。
 * 这些分支在真实设备上很难复现（要等 24 小时、要真的撞 OOM），所以必须单测兜住。
 */
import {
  THREAD_PREF_KEY, THREAD_PREF_TTL_MS,
  readThreadPref, rememberThreadPref, preferredThreads,
} from '../src/threadPref.js'

const NOW = 1_700_000_000_000

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
  }
}

const results = []
const check = (label, ok) => {
  results.push([label, ok])
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
}

console.log('=== 线程降级记忆（含自动过期恢复）===')

// 1) 没有记忆 → 用自动值
check('无记忆时使用自动值', preferredThreads({ storage: makeStorage(), ceiling: 4, now: NOW }) === 4)

// 2) 记忆有效 → 沿用降级
{
  const s = makeStorage({ [THREAD_PREF_KEY]: JSON.stringify({ threads: 2, expiresAt: NOW + 1000 }) })
  check('降级记忆未过期时沿用（ceiling 4 → 2）', preferredThreads({ storage: s, ceiling: 4, now: NOW }) === 2)
}

// 3) 记忆过期 → 自动恢复（这是本次新增的核心行为）
{
  const s = makeStorage({ [THREAD_PREF_KEY]: JSON.stringify({ threads: 1, expiresAt: NOW - 1 }) })
  check('降级记忆过期后自动恢复自动值（4）', preferredThreads({ storage: s, ceiling: 4, now: NOW }) === 4)
  check('过期记忆被就地清除', s.getItem(THREAD_PREF_KEY) === null)
}

// 4) 边界：正好到期算过期
{
  const s = makeStorage({ [THREAD_PREF_KEY]: JSON.stringify({ threads: 1, expiresAt: NOW }) })
  check('恰好到期即视为过期', preferredThreads({ storage: s, ceiling: 4, now: NOW }) === 4)
}

// 5) 旧格式（纯数字）兼容 + 迁移
{
  const s = makeStorage({ [THREAD_PREF_KEY]: '1' })
  check('旧格式纯数字仍被尊重', preferredThreads({ storage: s, ceiling: 4, now: NOW }) === 1)
  const migrated = JSON.parse(s.getItem(THREAD_PREF_KEY))
  check('旧格式被迁移为 { threads, expiresAt }', migrated.threads === 1 && migrated.expiresAt === NOW + THREAD_PREF_TTL_MS)
}

// 6) 降级值不会越过本次 ceiling（例如跨源隔离失效退回 1）
{
  const s = makeStorage({ [THREAD_PREF_KEY]: JSON.stringify({ threads: 4, expiresAt: NOW + 1000 }) })
  check('记忆值不超过本次 ceiling（隔离失效 → 1）', preferredThreads({ storage: s, ceiling: 1, now: NOW }) === 1)
}

// 7) 写入带完整有效期
{
  const s = makeStorage()
  rememberThreadPref(s, 2, NOW)
  const written = JSON.parse(s.getItem(THREAD_PREF_KEY))
  check('写入时带完整有效期', written.threads === 2 && written.expiresAt === NOW + THREAD_PREF_TTL_MS)
}

// 8) storage 不可用（Safari 隐私模式）不能崩
{
  const broken = {
    getItem() { throw new Error('SecurityError') },
    setItem() { throw new Error('SecurityError') },
    removeItem() { throw new Error('SecurityError') },
  }
  check('storage 不可用时退回自动值', preferredThreads({ storage: broken, ceiling: 3, now: NOW }) === 3)
  let threw = false
  try { rememberThreadPref(broken, 1, NOW) } catch { threw = true }
  check('storage 不可用时写入不抛错', threw === false)
  check('storage 为 null 时不崩', preferredThreads({ storage: null, ceiling: 2, now: NOW }) === 2)
}

// 9) 垃圾值不能变成「线程数 = NaN」这种东西
{
  const s1 = makeStorage({ [THREAD_PREF_KEY]: 'not-json{' })
  check('非 JSON 垃圾值当作无记忆', preferredThreads({ storage: s1, ceiling: 4, now: NOW }) === 4)
  const s2 = makeStorage({ [THREAD_PREF_KEY]: '{ 坏掉的 json' })
  check('JSON 解析失败当作无记忆', preferredThreads({ storage: s2, ceiling: 4, now: NOW }) === 4)
  const s3 = makeStorage({ [THREAD_PREF_KEY]: JSON.stringify({ threads: 0, expiresAt: NOW + 1000 }) })
  check('threads=0 视为无记忆', preferredThreads({ storage: s3, ceiling: 4, now: NOW }) === 4)
  const s4 = makeStorage({ [THREAD_PREF_KEY]: JSON.stringify({ expiresAt: NOW + 1000 }) })
  check('缺 threads 字段视为无记忆', preferredThreads({ storage: s4, ceiling: 4, now: NOW }) === 4)
}

// 10) 读出的线程数必须是合法正整数
{
  const s = makeStorage({ [THREAD_PREF_KEY]: JSON.stringify({ threads: -3, expiresAt: NOW + 1000 }) })
  check('负数线程数视为无记忆', preferredThreads({ storage: s, ceiling: 4, now: NOW }) === 4)
  check('readThreadPref 直接调用同样安全', readThreadPref(makeStorage(), NOW) === 0)
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\n线程降级记忆：${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.error('失败项：' + failed.map(([label]) => label).join('、'))
  process.exit(1)
}
