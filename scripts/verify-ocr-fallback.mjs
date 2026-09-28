import assert from 'node:assert/strict'
import { normalizedWatermarkText, watermarkKind, ocrItemsToRegions } from '../src/ocr-fallback.js'
import { claheGrayRgba } from '../src/clahe.js'

const item = (text, x, y, width, height, score = 0.98) => ({
  text, score,
  poly: [[x, y], [x + width, y], [x + width, y + height], [x, y + height]],
})

assert.equal(normalizedWatermarkText('ＡＩ 生 成'), 'AI生成')
assert.equal(watermarkKind('豆包 AI 生 成'), '豆包')
for (const name of ['豆包', '即梦', '千问', '清言', '元宝', '文心']) {
  assert.equal(watermarkKind(name), name)
  assert.equal(watermarkKind(`${name}AI`), name)
}
assert.equal(watermarkKind('Gemini'), 'Gemini')
assert.equal(watermarkKind('这是豆包的食谱'), null)
assert.equal(watermarkKind('千问自己'), null)
assert.equal(watermarkKind('小红书号：2917353068'), '小红书')
assert.equal(watermarkKind('小红书号：照片'), null)
assert.equal(watermarkKind('普通角落文字'), null)

const xhs = ocrItemsToRegions([
  item('小红书', 459, 327, 63, 26),
  item('小红书号：2917353068', 283, 373, 252, 27),
  item('该多好', 0, 62, 404, 176),
], 520, 995, 1084, 1422)
assert.equal(xhs.length, 1)
assert.equal(xhs[0].provider, '小红书')
assert.ok(xhs[0].y < 995 + 327, '区域应包含账号上方的小红书标志')
assert.ok(xhs[0].x <= 520 + 283, '区域应包含整条账号文字')

const split = ocrItemsToRegions([
  item('豆包', 10, 10, 40, 18),
  item('AI', 55, 10, 21, 18),
  item('生成', 78, 10, 38, 18),
], 100, 200, 1000, 1000)
assert.equal(split.length, 1)
assert.equal(split[0].text, '豆包AI生成')
assert.equal(split[0].provider, '豆包')

const brandOnly = ocrItemsToRegions([item('清言', 15, 12, 40, 18)], 0, 0, 1000, 1000)
assert.equal(brandOnly.length, 1)
assert.equal(brandOnly[0].provider, '清言')
assert.deepEqual(ocrItemsToRegions([item('这是豆包的食谱', 15, 12, 120, 18)], 0, 0, 1000, 1000), [])

assert.deepEqual(ocrItemsToRegions([
  item('AI生成', 20, 20, 90, 20, 0.2),
  item('小红书号：123456', 20, 120, 200, 20, 0.2),
], 0, 0, 1000, 1000), [])

const width = 128
const height = 128
const faint = new Uint8ClampedArray(width * height * 4)
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4
    const level = 100 + Math.floor(x / 8) + (y >= 50 && y < 62 && x >= 30 && x < 100 ? 5 : 0)
    faint[at] = faint[at + 1] = faint[at + 2] = level
    faint[at + 3] = 255
  }
}
const enhanced = claheGrayRgba(faint, width, height)
const pixel = (buffer, x, y) => buffer[(y * width + x) * 4]
assert.ok(pixel(enhanced, 40, 55) - pixel(enhanced, 40, 45) > 5, 'CLAHE 应增强淡字的局部对比度')
assert.equal(pixel(faint, 40, 55) - pixel(faint, 40, 45), 5, '不能改写原图输入')
assert.equal(enhanced[(55 * width + 40) * 4 + 3], 255)

console.log('OCR 文字匹配、分行、区域与 CLAHE 校验通过')
