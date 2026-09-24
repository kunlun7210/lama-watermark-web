import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'

import { MASK_SOURCES } from '../src/maskData.js'
import { doubaoCandidateIsValid } from '../src/rules.js'

const source = MASK_SOURCES.doubaoV2
if (!source || source.shape[0] !== 55 || source.shape[1] !== 251) {
  throw new Error('豆包新版模板尺寸不正确')
}

const packed = inflateSync(Buffer.from(source.bits, 'base64'))
const expectedBytes = Math.ceil((source.shape[0] * source.shape[1]) / 8)
if (packed.byteLength !== expectedBytes) throw new Error('豆包新版模板数据长度不正确')

const mask = new Uint8Array(source.shape[0] * source.shape[1])
for (let index = 0; index < mask.length; index++) {
  mask[index] = (packed[index >> 3] >> (7 - (index & 7))) & 1 ? 255 : 0
}
const foreground = mask.reduce((sum, value) => sum + (value ? 1 : 0), 0)
const digest = createHash('sha256').update(mask).digest('hex')
if (foreground !== 7811) throw new Error(`豆包新版模板前景像素不正确：${foreground}`)
if (digest !== '0ff42a6c22029665b74de1e213de71af2b8738a4b12dd136f2fa2bc5b0675a9d') {
  throw new Error(`豆包新版模板哈希不匹配：${digest}`)
}

if (!doubaoCandidateIsValid({ contrast: 8, shapeScore: 0.45 }, 'classic')) {
  throw new Error('豆包经典模板边界候选应通过')
}
if (doubaoCandidateIsValid({ contrast: 8, shapeScore: 0.4499 }, 'classic')) {
  throw new Error('豆包经典模板形状不足时不应通过')
}
if (!doubaoCandidateIsValid({ contrast: 18, shapeScore: 0.36 }, 'v2')) {
  throw new Error('豆包新版模板边界候选应通过')
}
if (doubaoCandidateIsValid({ contrast: 17.99, shapeScore: 0.36 }, 'v2')) {
  throw new Error('豆包新版模板对比度不足时不应通过')
}
if (doubaoCandidateIsValid({ contrast: 18, shapeScore: 0.3599 }, 'v2')) {
  throw new Error('豆包新版模板形状不足时不应通过')
}

console.log(`豆包双模板校验通过：新版模板 ${foreground} 像素，SHA-256 ${digest}`)
