// 批次上限的唯一真相源。
//
// 这组判定必须**脱离浏览器**也能测：超限追加是「整次拒绝」这种原子语义，
// 用真机/浏览器去构造 40 张边界既慢又难覆盖所有组合（恰好 200MB、同时超两项……），
// 所以把它提成纯函数，主流程与单测共用同一份实现 —— 不会出现「测的是一套、跑的是另一套」。

/** 单批最多多少张 */
export const BATCH_LIMIT_COUNT = 40
/** 单批原图总量上限（字节） */
export const BATCH_LIMIT_BYTES = 200 * 1024 * 1024

/**
 * 候选批次是否超限。
 *
 * @param {{file?: {size?: number}, size?: number}[]} items 候选批次（已有条目 + 本次接受的文件）
 * @returns {null | {code: 'count'|'bytes', count: number, limit: number, total: number}} 超限原因；不超限返回 null
 *
 * 判定顺序是「先张数、后体积」，且**只用 `>` 判断** —— 40 张整、200MB 整都算合法，
 * 恰好等于上限不该被拒绝。
 */
export function batchLimitReason(items) {
  const list = Array.isArray(items) ? items : []
  const count = list.length
  const total = list.reduce((sum, item) => sum + batchItemSize(item), 0)
  if (count > BATCH_LIMIT_COUNT) {
    return { code: 'count', count, limit: BATCH_LIMIT_COUNT, total }
  }
  if (total > BATCH_LIMIT_BYTES) {
    return { code: 'bytes', count, limit: BATCH_LIMIT_BYTES, total }
  }
  return null
}

/** 单条目体积：正常条目挂在 item.file 上；也接受直接传 {size}（测试与防御用） */
function batchItemSize(item) {
  const size = item?.file?.size ?? item?.size ?? 0
  return Number.isFinite(size) && size > 0 ? size : 0
}

/** 超限提示文案。张数/体积都从常量推导，改上限不用改文案 */
export function batchLimitMessage(reason, existingCount) {
  const kept = `现有 ${existingCount} 张及结果已保留`
  if (reason?.code === 'bytes') {
    return `无法追加：原图超过 ${Math.round(reason.limit / 1048576)}MB；${kept}`
  }
  return `无法追加：超过 ${reason?.limit || BATCH_LIMIT_COUNT} 张；${kept}`
}
