// 超限追加的边界判定（纯函数，无需浏览器）。
//
// 这条边界必须逐点验：40 张整 / 200MB 整都不该被拒（只有 `>` 才拒），
// 而「同时超两项」时报哪一种原因、文案里现有张数对不对，都直接决定用户看到什么。
// 用真机去构造这些组合不现实（要真的选 40 张图），所以判定做成纯函数在这里穷举。
import { BATCH_LIMIT_BYTES, BATCH_LIMIT_COUNT, batchLimitMessage, batchLimitReason } from '../src/batch-limits.js'

const MB = 1024 * 1024
const many = count => Array.from({ length: count }, () => ({ file: { size: 1 } }))
/** 构造总量恰好为 bytes 的 n 个条目（挂在 file.size 上，不需要真的分配这么多字节） */
const weigh = (count, bytes) => {
  const each = Math.floor(bytes / count)
  const items = Array.from({ length: count }, () => ({ file: { size: each } }))
  items[0].file.size += bytes - each * count
  return items
}
const sum = items => items.reduce((total, item) => total + item.file.size, 0)

let failed = 0
const check = (label, ok) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failed++
}

console.log('=== 批次上限判定 ===')
check('空列表不超限', batchLimitReason([]) === null)
check(`恰好 ${BATCH_LIMIT_COUNT} 张允许（边界闭区间）`, batchLimitReason(many(BATCH_LIMIT_COUNT)) === null)
check(`${BATCH_LIMIT_COUNT + 1} 张被拒`, batchLimitReason(many(BATCH_LIMIT_COUNT + 1))?.code === 'count')

const exact = weigh(BATCH_LIMIT_COUNT, BATCH_LIMIT_BYTES)
check(`总量恰好 200MB 允许（${sum(exact)} 字节）`, sum(exact) === BATCH_LIMIT_BYTES && batchLimitReason(exact) === null)

const over = weigh(BATCH_LIMIT_COUNT, BATCH_LIMIT_BYTES + 1)
check('总量 200MB+1 字节被拒', sum(over) === BATCH_LIMIT_BYTES + 1 && batchLimitReason(over)?.code === 'bytes')

const bothOver = Array.from({ length: BATCH_LIMIT_COUNT + 5 }, () => ({ file: { size: BATCH_LIMIT_BYTES } }))
check('同时超两项时报「张数」（判定顺序稳定）', batchLimitReason(bothOver)?.code === 'count')

check('裸 {size} 与 {file:{size}} 等价计入',
  batchLimitReason([{ size: 5 }, { file: { size: 5 } }]) === null
  && batchLimitReason([...weigh(39, 1), { size: BATCH_LIMIT_BYTES }])?.code === 'bytes')
check('非法体积按 0 处理（不因 NaN 误判超限）', batchLimitReason([{ size: Number.NaN }, { size: -100 }, {}]) === null)

console.log('\n=== 提示文案 ===')
const countText = batchLimitMessage(batchLimitReason(many(BATCH_LIMIT_COUNT + 1)), 3)
const bytesText = batchLimitMessage(batchLimitReason(over), 3)
check(`张数文案：${countText}`, countText === `无法追加：超过 ${BATCH_LIMIT_COUNT} 张；现有 3 张及结果已保留`)
check(`体积文案：${bytesText}`, bytesText === `无法追加：原图超过 ${BATCH_LIMIT_BYTES / MB}MB；现有 3 张及结果已保留`)
check('文案里不含 undefined / NaN', !/undefined|NaN/.test(countText + bytesText))

console.log('')
if (failed) throw new Error(`批次上限判定有 ${failed} 项未通过`)
console.log(`batch-limits: ${BATCH_LIMIT_COUNT} 张 / ${BATCH_LIMIT_BYTES / MB}MB 边界与文案已核对`)
