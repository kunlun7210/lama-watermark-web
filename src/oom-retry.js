import { lowerThreadCount } from './thread-policy.js'

const OOM_PATTERNS = [
  /out of memory/i,
  /memory access out of bounds/i,
  /could not allocate memory/i,
  /cannot enlarge memory/i,
  /allocation failed/i,
  /std::bad_alloc/i,
  /aborted\s*\(\s*oom\s*\)/i,
]

export function isOutOfMemory(error) {
  const text = `${error?.name || ''}: ${error?.message || error || ''}`
  return OOM_PATTERNS.some(pattern => pattern.test(text))
}

export async function runWithOomFallback({
  run,
  getThreads,
  setThreads,
  rebuild,
  onRetry = () => {},
  maxRetries = 2,
}) {
  let retries = 0
  while (true) {
    try {
      return await run()
    } catch (error) {
      const current = getThreads()
      if (!isOutOfMemory(error) || current <= 1 || retries >= maxRetries) throw error
      retries++
      const next = lowerThreadCount(current)
      setThreads(next)
      await rebuild(next, error)
      await onRetry(next, retries, error)
    }
  }
}
