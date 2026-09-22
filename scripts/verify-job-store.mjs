import assert from 'node:assert/strict'
import {
  BATCH_LIMIT_BYTES,
  BATCH_LIMIT_COUNT,
  batchLimitReason,
  saveBatch,
} from '../src/job-store.js'

const item = size => ({ file: { size } })

assert.equal(batchLimitReason(Array.from({ length: BATCH_LIMIT_COUNT }, () => item(1))), '')
assert.match(batchLimitReason(Array.from({ length: BATCH_LIMIT_COUNT + 1 }, () => item(1))), /超过 40 张/)
assert.equal(batchLimitReason([item(BATCH_LIMIT_BYTES)]), '')
assert.match(batchLimitReason([item(BATCH_LIMIT_BYTES + 1)]), /原图超过 220MB/)

// Node 没有 IndexedDB。超限保存必须在接触数据库前安全返回；旧实现会调用
// clearStoredJob()，因此这里会直接失败，能防止“追加超限清空已有结果”回归。
const rejected = await saveBatch(Array.from({ length: BATCH_LIMIT_COUNT + 1 }, () => item(1)))
assert.equal(rejected.saved, false)
assert.match(rejected.reason, /已保留现有任务和结果/)

console.log('job-store policy verified')
