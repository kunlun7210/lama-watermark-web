/**
 * OOM 降级记忆：把「这台设备的 WASM 多线程会爆内存」记下来，但**带有效期**。
 *
 * 为什么不是永久记住：多线程下 ORT 的峰值内存会超 iOS 单页配额，降级是必要的；
 * 但触发原因常常是**偶发**的（当时后台开着别的标签页、系统正在压缩内存），
 * 把它当成永久结论会把设备一直钉在低线程上，性能差 2–4 倍且用户无从察觉。
 *
 * 所以设计成：
 * - 记下的降级**会在有效期后自动失效**，回到自动线程数 —— 全程无需用户操作，也就没有按钮。
 * - 真正吃紧的机型会在下一次 OOM 时重新写入（续期），记忆不会丢；
 *   代价只是每天多一次「按自动值探测 → 失败 → 当场降级重试」，而免刷新重试本来就已经实现。
 * - 过期后也是回到自动值而不是一直用 1 线程：设备条件可能已经改善（换了手机、少开标签页）。
 *
 * 存储值为 JSON：{ threads, expiresAt }。历史遗留的纯数字格式会被就地迁移。
 */

export const THREAD_PREF_KEY = 'lama-threads'

/** 降级记忆的有效期。偶发内存压力通常几十分钟内就缓解，24 小时足够宽裕。 */
export const THREAD_PREF_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 读出仍然有效的降级线程数；返回 0 表示「没有可用的降级记忆，用自动值」。
 * 副作用：过期即清除；遇到旧格式会迁移成新格式。
 */
export function readThreadPref(storage, now = Date.now()) {
  let raw = null
  try { raw = storage?.getItem(THREAD_PREF_KEY) ?? null } catch { return 0 }
  if (raw === null || raw === '') return 0

  const text = String(raw).trim()
  let threads = 0
  let expiresAt = 0

  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      threads = Number(parsed?.threads) || 0
      expiresAt = Number(parsed?.expiresAt) || 0
    } catch { threads = 0 }
  } else {
    // 旧格式（纯数字）没有过期信息：按「刚刚降级」处理并给一个完整有效期，
    // 避免升级后第一次打开就又撞一次 OOM。
    threads = Number(text) || 0
    expiresAt = now + THREAD_PREF_TTL_MS
  }

  if (threads <= 0) { forgetThreadPref(storage); return 0 }
  if (now >= expiresAt) { forgetThreadPref(storage); return 0 }   // 过期：自动恢复
  if (!text.startsWith('{')) rememberThreadPref(storage, threads, now)  // 顺手迁移
  return threads
}

/** 记下降级结果并刷新有效期（每次真的发生 OOM 降级都会续期） */
export function rememberThreadPref(storage, threads, now = Date.now()) {
  try {
    storage?.setItem(THREAD_PREF_KEY, JSON.stringify({
      threads,
      expiresAt: now + THREAD_PREF_TTL_MS,
    }))
  } catch { /* 隐私模式等写不进去：忽略，不能因此影响推理 */ }
}

export function forgetThreadPref(storage) {
  try { storage?.removeItem(THREAD_PREF_KEY) } catch { /* 忽略 */ }
}

/** 本次该用几个线程：跨源隔离才有得选（ceiling），再叠加仍然有效的降级记忆 */
export function preferredThreads({ storage, ceiling, now = Date.now() } = {}) {
  const cap = Number(ceiling) > 0 ? Math.floor(Number(ceiling)) : 1
  const saved = readThreadPref(storage, now)
  return saved > 0 ? Math.max(1, Math.min(saved, cap)) : cap
}
