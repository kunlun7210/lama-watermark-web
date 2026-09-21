import { createHash } from 'node:crypto'
import { GEMINI_ALPHA_DATA } from '../src/gemini-alpha-data.js'
import {
  GEMINI_FALLBACK_MAX_RESIDUAL,
  geminiAlphaBytes,
  geminiCandidateIsValid,
  geminiFallbackIsValid,
  processGemini,
} from '../src/gemini.js'

const expected = {
  48: { length: 48 * 48, sha256: '5009eebd2969e887aa29235978169f7ea21d4cf039658a9a9f590a8d2be55ccb' },
  96: { length: 96 * 96, sha256: '06f0fe1d7e23bbbb2c8700cea09b4128b6a192f2ec69daa730538a279c4ad855' },
}

for (const [sizeText, pinned] of Object.entries(expected)) {
  const size = Number(sizeText)
  const bytes = geminiAlphaBytes(size)
  if (!(bytes instanceof Uint8Array) || bytes.length !== pinned.length) {
    throw new Error(`Gemini ${size}px Alpha 模板长度不正确`)
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== pinned.sha256 || digest !== GEMINI_ALPHA_DATA[size].bytesSha256) {
    throw new Error(`Gemini ${size}px Alpha 模板哈希不匹配`)
  }
}

const accepted = [
  { size: 96, margin: 192, score: 0.36, spatial: 0.20, gradient: 0.10 },
  { size: 48, margin: 32, score: 0.56, spatial: 0.32, gradient: 0.30 },
]
const rejected = [
  { size: 96, margin: 192, score: 0.359, spatial: 0.50, gradient: 0.50 },
  { size: 96, margin: 64, score: 0.90, spatial: 0.319, gradient: 0.90 },
  { size: 48, margin: 32, score: 0.90, spatial: 0.90, gradient: 0.299 },
]
if (accepted.some(candidate => !geminiCandidateIsValid(candidate))) throw new Error('Gemini 检测阈值错误：边界候选应通过')
if (rejected.some(candidate => geminiCandidateIsValid(candidate))) throw new Error('Gemini 检测阈值错误：低于阈值的候选不应通过')
if (!geminiFallbackIsValid(GEMINI_FALLBACK_MAX_RESIDUAL)) throw new Error('Gemini LaMa 回退门槛边界应通过')
if (geminiFallbackIsValid(GEMINI_FALLBACK_MAX_RESIDUAL + 0.001)) throw new Error('高残差候选不应进入 LaMa')

// 一个完全离开右下角候选区的纯色图必须保持原图。
const blank = new Uint8ClampedArray(320 * 320 * 4)
for (let offset = 0; offset < blank.length; offset += 4) {
  blank[offset] = 31
  blank[offset + 1] = 47
  blank[offset + 2] = 63
  blank[offset + 3] = 255
}
const blankResult = processGemini(blank, 320, 320)
if (blankResult.status !== 'not-found') throw new Error('纯色图被误判为 Gemini 水印')

console.log('gemini: templates, thresholds and negative control verified')
