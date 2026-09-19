// 平台水印规则集：由 macOS App（WatermarkBatchLite）的 Python 检测器逐条移植。
// 几何、锚点、阈值、模板全部保持一致；识别不到时不猜测位置（fail closed）。
import { MASK_SOURCES } from './maskData.js'
import {
  canny, ccorrMax, ccorrMinMax, dilate, gaussianBlur, hsvFromRgb, nccMax,
  pearson, resizeArea, resizeNearest,
} from './imaging.js'

const oddWidth = (value) => {
  const v = Math.max(3, Math.round(value))
  return v % 2 === 0 ? v + 1 : v
}

const clampBox = (x, y, w, h, width, height) => {
  const left = Math.max(0, x)
  const top = Math.max(0, y)
  const right = Math.min(width, x + w)
  const bottom = Math.min(height, y + h)
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function base64ToBytes(text) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function inflate(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持解压水印模板，请升级 Safari')
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** 解码 App 里压缩的 1bit 模板（base64 + zlib + MSB unpackbits） */
export async function decodeMask(bits, shape) {
  const [maskHeight, maskWidth] = shape
  const raw = await inflate(base64ToBytes(bits))
  const expected = (maskHeight * maskWidth + 7) >> 3
  if (raw.length !== expected) throw new Error('水印模板数据长度不正确')
  const mask = new Uint8Array(maskHeight * maskWidth)
  for (let i = 0; i < mask.length; i++) {
    mask[i] = (raw[i >> 3] >> (7 - (i & 7))) & 1 ? 255 : 0
  }
  return mask
}

/** 内部 +1/N、外环 -1/M 的对比度核（内部与 Python 逐行对应） */
function contrastKernel(mask, width, height, ringWidth) {
  const inside = new Uint8Array(mask.length)
  let insideCount = 0
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] > 0) { inside[i] = 1; insideCount++ }
  }
  const dilated = dilate(mask, width, height, ringWidth)
  const ring = new Uint8Array(mask.length)
  let ringCount = 0
  for (let i = 0; i < mask.length; i++) {
    if (dilated[i] > 0 && !inside[i]) { ring[i] = 1; ringCount++ }
  }
  const kernel = new Float32Array(mask.length)
  if (insideCount) for (let i = 0; i < kernel.length; i++) if (inside[i]) kernel[i] = 1 / insideCount
  if (ringCount) for (let i = 0; i < kernel.length; i++) if (ring[i]) kernel[i] = -1 / ringCount
  return kernel
}

const scaledMaskNearest = (base, baseW, baseH, width, height) => (
  resizeNearest(base, baseW, baseH, width, height)
)

function subArray(src, srcWidth, x, y, width, height, out) {
  const dst = out && out.length === width * height ? out : new Float32Array(width * height)
  for (let row = 0; row < height; row++) {
    const srcRow = (y + row) * srcWidth + x
    const dstRow = row * width
    for (let col = 0; col < width; col++) dst[dstRow + col] = src[srcRow + col]
  }
  return dst
}

/** 取滑动窗口：xMax/yMax 为不含上界的结束坐标（对应 Python 的 [a:b] 切片） */
function searchWindow(src, srcWidth, xMin, yMin, xMax, yMax) {
  return subArray(src, srcWidth, xMin, yMin, xMax - xMin, yMax - yMin)
}

function anchorPosition(anchor, width, height, offsetX, offsetY, markWidth, markHeight) {
  const x = anchor.endsWith('left') ? offsetX : width - offsetX - markWidth
  const y = anchor.startsWith('top') ? offsetY : height - offsetY - markHeight
  return { x, y }
}

/** fixed_corner.py 的 detect_fixed_corner（高通用路径：清言 / 千问 / 在线规则） */
function detectFixedCorner(gray, width, height, options) {
  const {
    baseMask, maskWidth, maskHeight, referenceShortSide, anchor,
    offsetX, offsetY, minContrast, minShapeScore, searchRadius = 12,
    padding = 5, context = 64, useHighPass = true,
  } = options
  const scale = Math.min(width, height) / referenceShortSide
  const markWidth = Math.max(1, Math.round(maskWidth * scale))
  const markHeight = Math.max(1, Math.round(maskHeight * scale))
  if (markWidth >= width || markHeight >= height) return { found: false, contrast: 0, shapeScore: 0 }

  const mask = scaledMaskNearest(baseMask, maskWidth, maskHeight, markWidth, markHeight)
  const expected = anchorPosition(anchor, width, height, Math.round(offsetX * scale), Math.round(offsetY * scale), markWidth, markHeight)
  const radius = Math.max(4, Math.round(searchRadius * scale))
  const xMin = Math.max(0, expected.x - radius)
  const yMin = Math.max(0, expected.y - radius)
  const xMax = Math.min(width - markWidth, expected.x + radius)
  const yMax = Math.min(height - markHeight, expected.y + radius)
  if (xMin > xMax || yMin > yMax) return { found: false, contrast: 0, shapeScore: 0 }

  const window = searchWindow(gray, width, xMin, yMin, xMax + markWidth, yMax + markHeight)
  const windowWidth = xMax - xMin + markWidth
  const windowHeight = yMax - yMin + markHeight
  const kernel = contrastKernel(mask, markWidth, markHeight, oddWidth(7 * scale))
  const hit = ccorrMax(window, windowWidth, windowHeight, kernel, markWidth, markHeight)
  const contrast = hit.value
  const x = xMin + hit.x
  const y = yMin + hit.y

  const patch = subArray(gray, width, x, y, markWidth, markHeight)
  const maskFloat = new Float32Array(mask.length)
  for (let i = 0; i < mask.length; i++) maskFloat[i] = mask[i] / 255
  const shapeSource = useHighPass
    ? minusArrays(patch, gaussianBlur(patch, markWidth, markHeight, Math.max(1, 4 * scale)))
    : patch
  const shapeScore = pearson(shapeSource, maskFloat)
  if (!(contrast >= minContrast && shapeScore >= minShapeScore)) {
    return { found: false, contrast, shapeScore }
  }
  const pad = Math.max(2, Math.round(padding * scale))
  const box = clampBox(x - pad, y - pad, markWidth + pad * 2, markHeight + pad * 2, width, height)
  if (!box) return { found: false, contrast, shapeScore }
  const contrastStrength = clamp01((contrast - minContrast) / Math.max(20, minContrast))
  const shapeStrength = clamp01((shapeScore - minShapeScore) / Math.max(0.2, 1 - minShapeScore))
  return {
    found: true,
    contrast,
    shapeScore,
    confidence: Math.min(contrastStrength, shapeStrength),
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    context: Math.max(48, Math.round(context * scale)),
  }
}

const clamp01 = (value) => Math.max(0, Math.min(1, value))
const minusArrays = (a, b) => {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i]
  return out
}

/** doubao.py：多尺度模板 + 对比度最大化 */
function detectDoubao(gray, width, height, template) {
  const shortSide = Math.min(width, height)
  const baseScale = shortSide / 1600
  const factors = [0.78, 0.84, 0.90, 0.96, 1.00, 1.06, 1.12]
  let best = null
  for (const factor of factors) {
    const scale = baseScale * factor
    const markWidth = Math.max(30, Math.round(251 * scale))
    const markHeight = Math.max(8, Math.round(55 * scale))
    if (markWidth >= width || markHeight >= height) continue
    const resized = resizeArea(template, 251, 55, markWidth, markHeight)
    const mask = new Uint8Array(resized.length)
    for (let i = 0; i < resized.length; i++) mask[i] = resized[i] > 70 ? 255 : 0
    const kernel = contrastKernel(mask, markWidth, markHeight, 7)
    const expectedX = Math.round(width - 27 * scale - markWidth)
    const expectedY = Math.round(height - 32 * scale - markHeight)
    const radius = Math.max(12, Math.round(34 * scale))
    const xMin = Math.max(0, expectedX - radius)
    const yMin = Math.max(0, expectedY - radius)
    const xMax = Math.min(width - markWidth, expectedX + radius)
    const yMax = Math.min(height - markHeight, expectedY + radius)
    if (xMin > xMax || yMin > yMax) continue
    const window = searchWindow(gray, width, xMin, yMin, xMax + markWidth, yMax + markHeight)
    const hit = ccorrMax(window, xMax - xMin + markWidth, yMax - yMin + markHeight, kernel, markWidth, markHeight)
    const candidate = {
      x: xMin + hit.x, y: yMin + hit.y, markWidth, markHeight,
      contrast: hit.value, factor, resized,
    }
    if (!best || candidate.contrast > best.contrast) best = candidate
  }
  if (!best) return { found: false, provider: '豆包', contrast: 0, shapeScore: 0 }
  const patch = subArray(gray, width, best.x, best.y, best.markWidth, best.markHeight)
  const maskFloat = new Float32Array(best.resized.length)
  for (let i = 0; i < maskFloat.length; i++) maskFloat[i] = best.resized[i] / 255
  const shapeScore = pearson(patch, maskFloat)
  if (!(best.contrast >= 8.0 && shapeScore >= 0.45)) {
    return { found: false, provider: '豆包', contrast: best.contrast, shapeScore }
  }
  const repairPadding = Math.max(8, Math.round(shortSide * 0.006))
  return {
    found: true,
    provider: '豆包',
    contrast: best.contrast,
    shapeScore,
    confidence: Math.min(
      clamp01((best.contrast - 8.0) / 18.0),
      clamp01((shapeScore - 0.45) / 0.35),
    ),
    x: best.x, y: best.y, width: best.markWidth, height: best.markHeight,
    repairPadding,
    context: Math.max(160, repairPadding * 16),
  }
}

/** yuanbao.py：亮/暗双极性的元宝角标 */
function detectYuanbao(gray, width, height, baseMask) {
  const scale = Math.min(width, height) / 1152
  const markWidth = Math.max(1, Math.round(108 * scale))
  const markHeight = Math.max(1, Math.round(75 * scale))
  if (markWidth >= width || markHeight >= height) return { found: false, provider: '元宝AI' }
  const mask = scaledMaskNearest(baseMask, 108, 75, markWidth, markHeight)
  const expectedX = width - Math.round(128 * scale)
  const expectedY = height - Math.round(95 * scale)
  const radius = Math.max(4, Math.round(10 * scale))
  const xMin = Math.max(0, expectedX - radius)
  const yMin = Math.max(0, expectedY - radius)
  const xMax = Math.min(width - markWidth, expectedX + radius)
  const yMax = Math.min(height - markHeight, expectedY + radius)
  if (xMin > xMax || yMin > yMax) return { found: false, provider: '元宝AI' }
  const window = searchWindow(gray, width, xMin, yMin, xMax + markWidth, yMax + markHeight)
  const kernel = contrastKernel(mask, markWidth, markHeight, oddWidth(7 * scale))
  const hit = ccorrMinMax(window, xMax - xMin + markWidth, yMax - yMin + markHeight, kernel, markWidth, markHeight)
  const useMin = Math.abs(hit.min) > Math.abs(hit.max)
  const contrast = useMin ? hit.min : hit.max
  const x = xMin + (useMin ? hit.minX : hit.maxX)
  const y = yMin + (useMin ? hit.minY : hit.maxY)
  const patch = subArray(gray, width, x, y, markWidth, markHeight)
  const maskFloat = new Float32Array(mask.length)
  for (let i = 0; i < mask.length; i++) maskFloat[i] = mask[i] / 255
  const shapeScore = pearson(patch, maskFloat)
  const contrastStrength = Math.abs(contrast)
  const shapeStrength = Math.abs(shapeScore)
  if (!(contrastStrength >= 30.0 && shapeStrength >= 0.60)) {
    return { found: false, provider: '元宝AI', contrast, shapeScore }
  }
  const boxX = Math.max(0, x - Math.round(4 * scale))
  const boxY = Math.max(0, y - Math.round(5 * scale))
  return {
    found: true,
    provider: '元宝AI',
    contrast,
    shapeScore,
    polarity: contrast >= 0 ? 'light' : 'dark',
    confidence: Math.min(
      clamp01((contrastStrength - 30.0) / 45.0),
      clamp01((shapeStrength - 0.60) / 0.30),
    ),
    x: boxX,
    y: boxY,
    width: Math.min(width - boxX, Math.max(1, Math.round(110 * scale))),
    height: Math.min(height - boxY, Math.max(1, Math.round(78 * scale))),
    context: Math.max(48, Math.round(64 * scale)),
  }
}

/** wenxin.py：左下角「文心AI生成」 */
function detectWenxin(gray, width, height, baseMask) {
  const scale = Math.min(width, height) / 1600
  const markWidth = Math.max(1, Math.round(240 * scale))
  const markHeight = Math.max(1, Math.round(64 * scale))
  if (markWidth >= width || markHeight >= height) return { found: false, provider: '文心AI' }
  const mask = scaledMaskNearest(baseMask, 240, 64, markWidth, markHeight)
  const expectedX = Math.round(25 * scale)
  const expectedY = height - Math.round(82 * scale)
  const radius = Math.max(4, Math.round(10 * scale))
  const xMin = Math.max(0, expectedX - radius)
  const yMin = Math.max(0, expectedY - radius)
  const xMax = Math.min(width - markWidth, expectedX + radius)
  const yMax = Math.min(height - markHeight, expectedY + radius)
  if (xMin > xMax || yMin > yMax) return { found: false, provider: '文心AI' }
  const window = searchWindow(gray, width, xMin, yMin, xMax + markWidth, yMax + markHeight)
  const kernel = contrastKernel(mask, markWidth, markHeight, oddWidth(7 * scale))
  const hit = ccorrMax(window, xMax - xMin + markWidth, yMax - yMin + markHeight, kernel, markWidth, markHeight)
  const x = xMin + hit.x
  const y = yMin + hit.y
  const patch = subArray(gray, width, x, y, markWidth, markHeight)
  const maskFloat = new Float32Array(mask.length)
  for (let i = 0; i < mask.length; i++) maskFloat[i] = mask[i] / 255
  const shapeScore = pearson(patch, maskFloat)
  if (!(hit.value >= 35.0 && shapeScore >= 0.65)) {
    return { found: false, provider: '文心AI', contrast: hit.value, shapeScore }
  }
  const boxX = Math.max(0, x - Math.round(2 * scale))
  const boxY = Math.max(0, y - Math.round(3 * scale))
  return {
    found: true,
    provider: '文心AI',
    contrast: hit.value,
    shapeScore,
    confidence: Math.min(
      clamp01((hit.value - 35.0) / 60.0),
      clamp01((shapeScore - 0.65) / 0.25),
    ),
    x: boxX,
    y: boxY,
    width: Math.min(width - boxX, Math.max(1, Math.round(240 * scale))),
    height: Math.min(height - boxY, Math.max(1, Math.round(60 * scale))),
    context: Math.max(56, Math.round(80 * scale)),
  }
}

/** jimeng.py：右下「即梦AI」为识别信号，左上「AI生成」独立确认后一起修复 */
function detectJimeng(gray, width, height, topMask, bottomMask) {
  const scale = Math.min(width, height) / 1728
  const bottomWidth = Math.max(1, Math.round(468 * scale))
  const bottomHeight = Math.max(1, Math.round(160 * scale))
  if (bottomWidth >= width || bottomHeight >= height) return { found: false, provider: '即梦AI' }
  const mask = resizeNearest(bottomMask, 468, 160, bottomWidth, bottomHeight)
  const expectedX = width - bottomWidth
  const expectedY = height - Math.round(184 * scale)
  const radius = Math.max(5, Math.round(18 * scale))
  const xMin = Math.max(0, expectedX - radius)
  const yMin = Math.max(0, expectedY - radius)
  const xMax = Math.min(width - bottomWidth, expectedX + radius)
  const yMax = Math.min(height - bottomHeight, expectedY + radius)
  if (xMin > xMax || yMin > yMax) return { found: false, provider: '即梦AI' }
  const window = searchWindow(gray, width, xMin, yMin, xMax + bottomWidth, yMax + bottomHeight)
  const kernel = contrastKernel(mask, bottomWidth, bottomHeight, oddWidth(7 * scale))
  const hit = ccorrMax(window, xMax - xMin + bottomWidth, yMax - yMin + bottomHeight, kernel, bottomWidth, bottomHeight)
  const x = xMin + hit.x
  const y = yMin + hit.y
  const patch = subArray(gray, width, x, y, bottomWidth, bottomHeight)
  const maskFloat = new Float32Array(mask.length)
  for (let i = 0; i < mask.length; i++) maskFloat[i] = mask[i] / 255
  const shapeScore = pearson(patch, maskFloat)
  if (!(hit.value >= 18.0 && shapeScore >= 0.42)) {
    return { found: false, provider: '即梦AI', contrast: hit.value, shapeScore }
  }

  const topScore = jimengTopScore(gray, width, height, topMask, scale)
  const confidence = Math.min(
    clamp01((hit.value - 18.0) / 35.0),
    clamp01((shapeScore - 0.42) / 0.35),
  )
  const regions = [
    boxRegion('即梦AI', 'AI生成',
      Math.round(8 * scale), Math.round(8 * scale),
      Math.max(1, Math.round(345 * scale)), Math.max(1, Math.round(150 * scale)),
      Math.max(64, Math.round(112 * scale))),
    boxRegion('即梦AI', '即梦AI',
      width - Math.round(400 * scale), height - Math.round(150 * scale),
      Math.max(1, Math.round(350 * scale)), Math.max(1, Math.round(98 * scale)),
      Math.max(56, Math.round(80 * scale))),
  ].filter((region, index) => index === 1 || topScore >= 0.18)
  return { found: true, provider: '即梦AI', contrast: hit.value, shapeScore, topScore, confidence, regions }
}

function boxRegion(provider, name, x, y, width, height, context) {
  const maskWidth = Math.max(1, Math.round(width))
  const maskHeight = Math.max(1, Math.round(height))
  const mask = new Uint8Array(maskWidth * maskHeight).fill(255)
  return {
    found: true,
    provider,
    name,
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: maskWidth,
    height: maskHeight,
    mask,
    maskWidth,
    maskHeight,
    context,
  }
}

function jimengTopScore(gray, width, height, topMask, scale) {
  const maskWidth = Math.max(1, Math.round(315 * scale))
  const maskHeight = Math.max(1, Math.round(130 * scale))
  const start = Math.max(0, Math.round(10 * scale))
  const end = Math.round(30 * scale)
  const margin = Math.max(4, Math.round(12 * scale))
  const cornerWidth = Math.min(width, end + maskWidth + margin)
  const cornerHeight = Math.min(height, end + maskHeight + margin)
  if (cornerWidth <= 0 || cornerHeight <= 0) return 0
  const corner = subArray(gray, width, 0, 0, cornerWidth, cornerHeight)
  const sigma = Math.max(0.5, 3 * scale)
  const highPass = minusArrays(corner, gaussianBlur(corner, cornerWidth, cornerHeight, sigma))
  const scaled = resizeNearest(topMask, 315, 130, maskWidth, maskHeight)
  const maskFloat = new Float32Array(scaled.length)
  for (let i = 0; i < scaled.length; i++) maskFloat[i] = scaled[i]
  const maskBlurred = gaussianBlur(maskFloat, maskWidth, maskHeight, sigma)
  const template = minusArrays(maskFloat, maskBlurred)
  const searchWidth = cornerWidth - start
  const searchHeight = cornerHeight - start
  if (searchWidth < maskWidth || searchHeight < maskHeight) return 0
  const search = subArray(highPass, cornerWidth, start, start, searchWidth, searchHeight)
  const hit = nccMax(search, searchWidth, searchHeight, template, maskWidth, maskHeight)
  return Number.isFinite(hit.value) ? hit.value : 0
}

/** xiaohongshu.py：旧版「小红书号」标签 + 新版白色徽标（含形状掩膜） */
function detectXiaohongshu(gray, gray8, rgba, width, height, labelTemplate, badgeMask) {
  const legacy = xhsLegacy(gray, width, height, labelTemplate)
  if (legacy.found) return legacy
  return xhsBadge(gray, gray8, rgba, width, height, badgeMask)
}

export const XHS_LEGACY_MIN_SCORE = 0.70
const XHS_BADGE_MIN_SCORE = 0.30

function xhsLegacy(gray, width, height, template) {
  const factors = [0.78, 0.88, 1.00, 1.12, 1.24]
  const baseScale = Math.min(width, height) / 960
  const darkness = new Float32Array(gray.length)
  for (let i = 0; i < gray.length; i++) darkness[i] = 255 - gray[i]
  let best = null
  for (const factor of factors) {
    const scale = baseScale * factor
    const labelWidth = Math.max(40, Math.round(99 * scale))
    const labelHeight = Math.max(10, Math.round(25 * scale))
    if (labelWidth >= width || labelHeight >= height) continue
    const scaled = resizeArea(template, 99, 25, labelWidth, labelHeight)
    const expectedX = Math.round(width - 253 * scale)
    const expectedY = Math.round(height - 47 * scale)
    const radius = Math.max(12, Math.round(28 * scale))
    const xMin = Math.max(0, expectedX - radius)
    const yMin = Math.max(0, expectedY - radius)
    const xMax = Math.min(width - labelWidth, expectedX + radius)
    const yMax = Math.min(height - labelHeight, expectedY + radius)
    if (xMin > xMax || yMin > yMax) continue
    const window = searchWindow(darkness, width, xMin, yMin, xMax + labelWidth, yMax + labelHeight)
    const hit = nccMax(window, xMax - xMin + labelWidth, yMax - yMin + labelHeight, scaled, labelWidth, labelHeight)
    const candidate = { labelX: xMin + hit.x, labelY: yMin + hit.y, labelWidth, labelHeight, scale, score: hit.value }
    if (!best || candidate.score > best.score) best = candidate
  }
  if (!best || best.score < XHS_LEGACY_MIN_SCORE) {
    return { found: false, provider: '小红书', score: best ? best.score : 0 }
  }
  const scale = best.scale
  const boxX = Math.max(0, best.labelX - Math.round(5 * scale))
  const boxY = Math.max(0, best.labelY - Math.round(best.labelHeight * 2))
  return {
    found: true,
    provider: '小红书',
    variant: 'legacy',
    score: best.score,
    confidence: clamp01((best.score - XHS_LEGACY_MIN_SCORE) / 0.25),
    x: boxX,
    y: boxY,
    width: Math.min(width - boxX, Math.round(best.labelWidth * 2.5)),
    height: Math.min(height - boxY, Math.round(best.labelHeight * 3.2)),
    context: 64,
  }
}

function xhsBadge(gray, gray8, rgba, width, height, badgeMask) {
  const sourceScale = width / 1440
  const normalizedHeight = Math.max(1, Math.round(height / sourceScale))
  const scaledGray = width === 1440
    ? gray8
    : resizeArea(Float32Array.from(gray8), width, height, 1440, normalizedHeight)
  const scaledGray8 = scaledGray instanceof Uint8Array ? scaledGray : Uint8Array.from(scaledGray, (v) => Math.max(0, Math.min(255, Math.round(v))))
  const edges = canny(scaledGray8, 1440, normalizedHeight, 40, 120)
  const edgesFloat = Float32Array.from(edges)

  let best = null
  for (const factor of [0.85, 0.92, 1.0, 1.08, 1.16]) {
    const badgeWidth = Math.max(30, Math.round(116 * factor))
    const badgeHeight = Math.max(12, Math.round(53 * factor))
    if (badgeWidth >= 1440 || badgeHeight >= normalizedHeight) continue
    const template = Float32Array.from(resizeNearest(badgeMask, 116, 53, badgeWidth, badgeHeight))
    const expectedX = 1440 - Math.round(36 * factor) - badgeWidth
    const expectedY = normalizedHeight - Math.round(84 * factor) - badgeHeight
    const radius = 18
    const xMin = Math.max(0, expectedX - radius)
    const yMin = Math.max(0, expectedY - radius)
    const xMax = Math.min(1440 - badgeWidth, expectedX + radius)
    const yMax = Math.min(normalizedHeight - badgeHeight, expectedY + radius)
    if (xMin > xMax || yMin > yMax) continue
    const window = searchWindow(edgesFloat, 1440, xMin, yMin, xMax + badgeWidth, yMax + badgeHeight)
    const hit = nccMax(window, xMax - xMin + badgeWidth, yMax - yMin + badgeHeight, template, badgeWidth, badgeHeight)
    const candidate = { badgeX: xMin + hit.x, badgeY: yMin + hit.y, badgeWidth, badgeHeight, score: hit.value }
    if (!best || candidate.score > best.score) best = candidate
  }
  if (!best || best.score < XHS_BADGE_MIN_SCORE) {
    return { found: false, provider: '小红书', score: best ? best.score : 0 }
  }

  const badgeX = Math.round(best.badgeX * sourceScale)
  const badgeY = Math.round(best.badgeY * sourceScale)
  const badgeWidth = Math.max(1, Math.round(best.badgeWidth * sourceScale))
  const badgeHeight = Math.max(1, Math.round(best.badgeHeight * sourceScale))

  const boxX = Math.max(0, Math.round((best.badgeX - 260) * sourceScale))
  const boxY = Math.max(0, Math.round((best.badgeY - 5) * sourceScale))
  const boxRight = Math.min(width, Math.round((best.badgeX + best.badgeWidth + 12) * sourceScale))
  const boxBottom = Math.min(height, Math.round((best.badgeY + best.badgeHeight + 64) * sourceScale))
  const maskWidth = Math.max(1, boxRight - boxX)
  const maskHeight = Math.max(1, boxBottom - boxY)
  const mask = new Uint8Array(maskWidth * maskHeight)
  const relativeX = badgeX - boxX
  const relativeY = badgeY - boxY
  const corner = Math.max(4, Math.round(13 * sourceScale))
  const inset = Math.max(3, Math.round(10 * sourceScale))
  const margin = Math.max(2, Math.round(3 * sourceScale))
  fillRect(mask, maskWidth, maskHeight,
    relativeX + inset, Math.max(0, relativeY - margin),
    relativeX + badgeWidth - inset, Math.min(maskHeight - 1, relativeY + badgeHeight + margin))
  fillRect(mask, maskWidth, maskHeight,
    Math.max(0, relativeX - margin), relativeY + inset,
    Math.min(maskWidth - 1, relativeX + badgeWidth + margin), relativeY + badgeHeight - inset)
  for (const cx of [relativeX + inset, relativeX + badgeWidth - inset]) {
    for (const cy of [relativeY + inset, relativeY + badgeHeight - inset]) {
      fillCircle(mask, maskWidth, maskHeight, cx, cy, corner)
    }
  }

  const accountTop = Math.min(maskHeight, relativeY + badgeHeight + Math.max(4, Math.round(7 * sourceScale)))
  const accountBottom = Math.min(maskHeight, relativeY + badgeHeight + Math.max(20, Math.round(57 * sourceScale)))
  let maskStrategy = 'badge-only'
  if (accountBottom > accountTop && maskWidth > 0 && boxBottom > boxY && boxRight > boxX) {
    const regionGray = subArray(gray, width, boxX, boxY, maskWidth, maskHeight)
    const sigma = Math.max(1, 3 * sourceScale)
    const blurred = gaussianBlur(regionGray, maskWidth, maskHeight, sigma)
    const stripHeight = accountBottom - accountTop
    const strip = new Uint8Array(maskWidth * stripHeight)
    for (let row = 0; row < stripHeight; row++) {
      for (let col = 0; col < maskWidth; col++) {
        const index = (accountTop + row) * maskWidth + col
        strip[row * maskWidth + col] = Math.max(0, Math.min(255, Math.round(regionGray[index])))
      }
    }
    const stripEdges = canny(strip, maskWidth, stripHeight, 40, 120)
    let edgeCount = 0
    for (let i = 0; i < stripEdges.length; i++) if (stripEdges[i]) edgeCount++
    const edgeDensity = edgeCount / stripEdges.length
    if (edgeDensity < 0.120) {
      for (let row = 0; row < stripHeight; row++) {
        for (let col = 0; col < maskWidth; col++) mask[(accountTop + row) * maskWidth + col] = 255
      }
      maskStrategy = 'smooth-line'
    } else {
      const { s, v } = hsvFromRgb(subRegionRgba(rgba, width, boxX, boxY, maskWidth, maskHeight), maskWidth, maskHeight)
      const textMask = new Uint8Array(maskWidth * stripHeight)
      for (let row = 0; row < stripHeight; row++) {
        for (let col = 0; col < maskWidth; col++) {
          const index = (accountTop + row) * maskWidth + col
          const brightness = regionGray[index] - blurred[index]
          textMask[row * maskWidth + col] = (brightness > 3.5 && s[index] < 105 && v[index] > 100) ? 255 : 0
        }
      }
      let dilation = Math.max(3, Math.round(5 * sourceScale))
      if (dilation % 2 === 0) dilation += 1
      const dilated = dilate(textMask, maskWidth, stripHeight, dilation)
      for (let row = 0; row < stripHeight; row++) {
        for (let col = 0; col < maskWidth; col++) {
          const index = (accountTop + row) * maskWidth + col
          mask[index] = Math.max(mask[index], dilated[row * maskWidth + col])
        }
      }
      maskStrategy = 'text-strokes'
    }
  }

  return {
    found: true,
    provider: '小红书',
    variant: 'badge',
    score: best.score,
    maskStrategy,
    confidence: clamp01((best.score - XHS_BADGE_MIN_SCORE) / 0.35),
    x: boxX,
    y: boxY,
    width: maskWidth,
    height: maskHeight,
    mask,
    maskWidth,
    maskHeight,
    context: Math.max(64, Math.round(96 * sourceScale)),
  }
}

function subRegionRgba(rgba, width, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let row = 0; row < h; row++) {
    const srcRow = ((y + row) * width + x) * 4
    const dstRow = row * w * 4
    out.set(rgba.subarray(srcRow, srcRow + w * 4), dstRow)
  }
  return out
}

function fillRect(mask, width, height, x0, y0, x1, y1) {
  const left = Math.max(0, Math.round(Math.min(x0, x1)))
  const right = Math.min(width - 1, Math.round(Math.max(x0, x1)))
  const top = Math.max(0, Math.round(Math.min(y0, y1)))
  const bottom = Math.min(height - 1, Math.round(Math.max(y0, y1)))
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) mask[y * width + x] = 255
  }
}

function fillCircle(mask, width, height, cx, cy, radius) {
  const r = Math.max(0, Math.round(radius))
  for (let y = cy - r; y <= cy + r; y++) {
    if (y < 0 || y >= height) continue
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || x >= width) continue
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= r * r) mask[y * width + x] = 255
    }
  }
}

function overlapRatio(a, b) {
  const ax2 = a.x + a.width
  const ay2 = a.y + a.height
  const bx2 = b.x + b.width
  const by2 = b.y + b.height
  const iw = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x))
  const ih = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y))
  const smaller = Math.min(a.width * a.height, b.width * b.height)
  return smaller ? (iw * ih) / smaller : 0
}

async function loadGrayTemplate(url, width, height) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`模板加载失败：HTTP ${response.status}`)
  const bitmap = await createImageBitmap(await response.blob())
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(bitmap, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  const gray = new Float32Array(canvas.width * canvas.height)
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = pixels[p]
  bitmap.close?.()
  return { data: gray, width: canvas.width, height: canvas.height }
}

/** 建立规则引擎：解码全部模板并加载两张 PNG 模板 */
export async function createRuleEngine(assetBase) {
  const masks = {}
  for (const [key, source] of Object.entries(MASK_SOURCES)) {
    masks[key] = await decodeMask(source.bits, source.shape)
  }
  const [doubao, xhsLabel] = await Promise.all([
    loadGrayTemplate(new URL('templates/doubao_logo_mask.png', assetBase).href),
    loadGrayTemplate(new URL('templates/xiaohongshu_label.png', assetBase).href),
  ])
  const templates = { doubao, xhsLabel }
  return {
    masks,
    templates,
    /**
     * 返回待修复区域列表；顺序、去重规则与 App 的 server.py 一致：
     * 即梦 → 元宝 → 文心 → 千问 → 清言 → 豆包 → 小红书，重叠 ≥60% 的后来者丢弃。
     */
    detect({ rgba, gray, gray8, width, height }) {
      const regions = []
      const push = (region) => {
        if (!region || !region.found) return
        if (regions.some((existing) => overlapRatio(existing, region) >= 0.60)) return
        regions.push(region)
      }
      const jimeng = detectJimeng(gray, width, height, masks.jimengTop, masks.jimengBottom)
      if (jimeng.found) for (const region of jimeng.regions) push(region)
      push(detectYuanbao(gray, width, height, masks.yuanbao))
      push(detectWenxin(gray, width, height, masks.wenxin))
      const qianwen = detectFixedCorner(gray, width, height, {
        baseMask: masks.qianwen, maskWidth: 184, maskHeight: 33,
        referenceShortSide: 768, anchor: 'bottom_right', offsetX: 26, offsetY: 26,
        minContrast: 25.0, minShapeScore: 0.50, context: 64, useHighPass: true,
      })
      if (qianwen.found) push({ ...qianwen, provider: '千问AI' })
      const qingyan = detectFixedCorner(gray, width, height, {
        baseMask: masks.qingyan, maskWidth: 163, maskHeight: 34,
        referenceShortSide: 768, anchor: 'bottom_right', offsetX: 17, offsetY: 12,
        minContrast: 8.0, minShapeScore: 0.50, context: 64, useHighPass: true,
      })
      if (qingyan.found) push({ ...qingyan, provider: '清言AI' })
      push(detectDoubao(gray, width, height, templates.doubao.data))
      push(detectXiaohongshu(gray, gray8, rgba, width, height, templates.xhsLabel.data, masks.xhsBadge))
      return regions
    },
    /** 调试用：逐个检测器输出原始分数，便于与 App 的 Python 结果逐项对齐 */
    debugDetect({ rgba, gray, gray8, width, height }) {
      return {
        元宝明细: (() => {
          const scale = Math.min(width, height) / 1152
          const markWidth = Math.max(1, Math.round(108 * scale))
          const markHeight = Math.max(1, Math.round(75 * scale))
          const mask = scaledMaskNearest(masks.yuanbao, 108, 75, markWidth, markHeight)
          const ringWidth = oddWidth(7 * scale)
          const kernel = contrastKernel(mask, markWidth, markHeight, ringWidth)
          let inside = 0
          let ring = 0
          for (let i = 0; i < kernel.length; i++) {
            if (kernel[i] > 0) inside++
            else if (kernel[i] < 0) ring++
          }
          const expectedX = width - Math.round(128 * scale)
          const expectedY = height - Math.round(95 * scale)
          const radius = Math.max(4, Math.round(10 * scale))
          const xMin = Math.max(0, expectedX - radius)
          const yMin = Math.max(0, expectedY - radius)
          const xMax = Math.min(width - markWidth, expectedX + radius)
          const yMax = Math.min(height - markHeight, expectedY + radius)
          const window = searchWindow(gray, width, xMin, yMin, xMax + markWidth, yMax + markHeight)
          const hit = ccorrMinMax(window, xMax - xMin + markWidth, yMax - yMin + markHeight, kernel, markWidth, markHeight)
          const useMin = Math.abs(hit.min) > Math.abs(hit.max)
          const bestX = xMin + (useMin ? hit.minX : hit.maxX)
          const bestY = yMin + (useMin ? hit.minY : hit.maxY)
          const patch = subArray(gray, width, bestX, bestY, markWidth, markHeight)
          let insideSum = 0
          let insideCount = 0
          let ringSum = 0
          let ringCount = 0
          for (let i = 0; i < kernel.length; i++) {
            if (kernel[i] > 0) { insideSum += patch[i]; insideCount++ }
            else if (kernel[i] < 0) { ringSum += patch[i]; ringCount++ }
          }
          const probe = (px, py) => {
            const patch = subArray(gray, width, xMin + px, yMin + py, markWidth, markHeight)
            let total = 0
            for (let i = 0; i < kernel.length; i++) total += kernel[i] * patch[i]
            return Math.round(total * 100) / 100
          }
          return {
            scale: Math.round(scale * 10000) / 10000, markWidth, markHeight, ringWidth,
            maskForeground: mask.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0),
            kernelInside: inside, kernelRing: ring,
            expected: [expectedX, expectedY], radius,
            window: [xMin, yMin, xMax, yMax],
            min: Math.round(hit.min * 100) / 100, minLocation: [hit.minX, hit.minY],
            max: Math.round(hit.max * 100) / 100, maxLocation: [hit.maxX, hit.maxY],
            probeBest: probe((useMin ? hit.minX : hit.maxX), (useMin ? hit.minY : hit.maxY)),
            best: [bestX, bestY],
            insideMean: insideCount ? Math.round((insideSum / insideCount) * 100) / 100 : null,
            ringMean: ringCount ? Math.round((ringSum / ringCount) * 100) / 100 : null,
          }
        })(),
        即梦: detectJimeng(gray, width, height, masks.jimengTop, masks.jimengBottom),
        元宝AI: detectYuanbao(gray, width, height, masks.yuanbao),
        文心AI: detectWenxin(gray, width, height, masks.wenxin),
        千问AI: detectFixedCorner(gray, width, height, {
          baseMask: masks.qianwen, maskWidth: 184, maskHeight: 33,
          referenceShortSide: 768, anchor: 'bottom_right', offsetX: 26, offsetY: 26,
          minContrast: 25.0, minShapeScore: 0.50, context: 64, useHighPass: true,
        }),
        清言AI: detectFixedCorner(gray, width, height, {
          baseMask: masks.qingyan, maskWidth: 163, maskHeight: 34,
          referenceShortSide: 768, anchor: 'bottom_right', offsetX: 17, offsetY: 12,
          minContrast: 8.0, minShapeScore: 0.50, context: 64, useHighPass: true,
        }),
        豆包: detectDoubao(gray, width, height, templates.doubao.data),
        小红书: detectXiaohongshu(gray, gray8, rgba, width, height, templates.xhsLabel.data, masks.xhsBadge),
      }
    },
  }
}
