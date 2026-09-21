/** 当前浏览器环境允许的最高线程数。 */
export function threadCeiling(isolated, hardwareConcurrency) {
  return isolated ? Math.min(4, hardwareConcurrency || 2) : 1
}

/** OOM 降级只由当前页面内存中的 runtimeCap 限制，不跨页面永久保存。 */
export function chooseThreadCount(isolated, hardwareConcurrency, runtimeCap = 0) {
  const ceiling = threadCeiling(isolated, hardwareConcurrency)
  return runtimeCap > 0 ? Math.max(1, Math.min(runtimeCap, ceiling)) : ceiling
}

/** 4 → 2 → 1；传入其它正整数时也至少保留 1 线程。 */
export function lowerThreadCount(current) {
  return current > 2 ? 2 : 1
}
