import { dilate, pearson } from './imaging.js'
import { GEMINI_ALPHA_DATA } from './gemini-alpha-data.js'

const LAYOUTS = [
  { size: 48, margin: 32 },
  { size: 96, margin: 64 },
  { size: 96, margin: 192 },
]

export const GEMINI_FALLBACK_MAX_RESIDUAL = 0.35

function decodeAlpha(size) {
  const source = GEMINI_ALPHA_DATA[size]
  if (!source) throw new Error(`缺少 Gemini ${size}px Alpha 模板`)
  const binary = atob(source.base64)
  if (binary.length !== size * size) throw new Error(`Gemini ${size}px Alpha 模板长度不正确`)
  const alpha = new Float32Array(binary.length)
  for (let index = 0; index < binary.length; index++) alpha[index] = binary.charCodeAt(index) / 255
  return alpha
}

const ALPHAS = new Map([
  [48, decodeAlpha(48)],
  [96, decodeAlpha(96)],
])

const reflect101 = (index, length) => {
  if (length === 1) return 0
  let value = index
  while (value < 0 || value >= length) {
    if (value < 0) value = -value
    else value = 2 * length - 2 - value
  }
  return value
}

/** cv2.magnitude(cv2.Sobel(...), cv2.Sobel(...))，使用默认 BORDER_REFLECT_101。 */
function edgeMagnitude(source, width, height, output) {
  const magnitude = output && output.length === source.length ? output : new Float32Array(source.length)
  for (let y = 0; y < height; y++) {
    const ym = reflect101(y - 1, height)
    const yp = reflect101(y + 1, height)
    for (let x = 0; x < width; x++) {
      const xm = reflect101(x - 1, width)
      const xp = reflect101(x + 1, width)
      const tl = source[ym * width + xm]
      const tc = source[ym * width + x]
      const tr = source[ym * width + xp]
      const ml = source[y * width + xm]
      const mr = source[y * width + xp]
      const bl = source[yp * width + xm]
      const bc = source[yp * width + x]
      const br = source[yp * width + xp]
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl)
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr)
      magnitude[y * width + x] = Math.hypot(gx, gy)
    }
  }
  return magnitude
}

function copyGrayPatch(rgba, sourceWidth, x, y, size, output) {
  const patch = output && output.length === size * size ? output : new Float32Array(size * size)
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const offset = ((y + row) * sourceWidth + x + col) * 4
      patch[row * size + col] = (
        0.2126 * rgba[offset] + 0.7152 * rgba[offset + 1] + 0.0722 * rgba[offset + 2]
      ) / 255
    }
  }
  return patch
}

export function geminiCandidateIsValid(candidate) {
  if (candidate.size === 96 && candidate.margin === 192) {
    return candidate.score >= 0.36 && candidate.spatial >= 0.20 && candidate.gradient >= 0.10
  }
  return candidate.spatial >= 0.32 && candidate.gradient >= 0.30
}

export function geminiFallbackIsValid(alphaResidual) {
  return Number.isFinite(alphaResidual) && alphaResidual <= GEMINI_FALLBACK_MAX_RESIDUAL
}

export function detectGemini(rgba, width, height) {
  let best = null
  let bestValid = null

  for (const { size, margin } of LAYOUTS) {
    if (size >= Math.min(width, height)) continue
    const baseX = width - margin - size
    const baseY = height - margin - size
    if (baseX < 0 || baseY < 0) continue
    const alpha = ALPHAS.get(size)
    const alphaEdge = edgeMagnitude(alpha, size, size)
    const patch = new Float32Array(size * size)
    const patchEdge = new Float32Array(size * size)
    const offsets = size === 96 && margin === 192
      ? [0]
      : (() => {
          const step = size >= 96 ? 4 : 2
          const radius = size >= 96 ? 24 : 16
          const values = []
          for (let offset = -radius; offset <= radius; offset += step) values.push(offset)
          return values
        })()

    for (const dx of offsets) {
      for (const dy of offsets) {
        const x = baseX + dx
        const y = baseY + dy
        if (x < 0 || y < 0 || x + size > width || y + size > height) continue
        copyGrayPatch(rgba, width, x, y, size, patch)
        const spatial = pearson(patch, alpha)
        edgeMagnitude(patch, size, size, patchEdge)
        const gradient = pearson(patchEdge, alphaEdge)
        const score = spatial + 0.8 * Math.max(0, gradient)
        const candidate = { x, y, size, margin, alpha, spatial, gradient, score }
        if (!best || score > best.score) best = candidate
        if (geminiCandidateIsValid(candidate) && (!bestValid || score > bestValid.score)) bestValid = candidate
      }
    }
  }

  if (!best) return { found: false, confidence: 0 }
  const selected = bestValid || best
  return {
    ...selected,
    found: !!bestValid,
    confidence: Math.max(0, Math.min(1, (Math.max(0, selected.spatial) + Math.max(0, selected.gradient)) / 2)),
  }
}

const srgbToLinear = value => (
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
)

const linearToSrgb = value => {
  const clipped = Math.max(0, Math.min(1, value))
  return clipped <= 0.0031308 ? clipped * 12.92 : 1.055 * clipped ** (1 / 2.4) - 0.055
}

function publicDetection(detection) {
  const { alpha: _alpha, ...publicValues } = detection
  return publicValues
}

export function processGemini(rgba, width, height) {
  const detection = detectGemini(rgba, width, height)
  if (!detection.found) {
    return { provider: 'Gemini', method: 'gemini-template', status: 'not-found', ...publicDetection(detection) }
  }

  const { x, y, size, alpha } = detection
  const pixels = size * size
  const patchLinear = new Float64Array(pixels * 3)
  const gray = new Float64Array(pixels)
  const sourceGray = new Float32Array(pixels)
  const restoredGray = new Float64Array(pixels)
  const sourceAlpha = new Uint8Array(pixels)

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const index = row * size + col
      const offset = ((y + row) * width + x + col) * 4
      const red = rgba[offset] / 255
      const green = rgba[offset + 1] / 255
      const blue = rgba[offset + 2] / 255
      patchLinear[index * 3] = srgbToLinear(red)
      patchLinear[index * 3 + 1] = srgbToLinear(green)
      patchLinear[index * 3 + 2] = srgbToLinear(blue)
      gray[index] = (patchLinear[index * 3] + patchLinear[index * 3 + 1] + patchLinear[index * 3 + 2]) / 3
      sourceGray[index] = (red + green + blue) / 3
      sourceAlpha[index] = rgba[offset + 3]
    }
  }

  let bestGain = 1
  let bestResidual = Infinity
  for (let gainIndex = 0; gainIndex < 83; gainIndex++) {
    const gain = 0.35 + gainIndex * 0.02
    for (let index = 0; index < pixels; index++) {
      const scaledAlpha = Math.min(alpha[index] * gain, 0.99)
      const value = scaledAlpha > 0.002 ? (gray[index] - scaledAlpha) / (1 - scaledAlpha) : gray[index]
      restoredGray[index] = Math.max(0, Math.min(1, value))
    }
    const residual = Math.abs(pearson(restoredGray, alpha))
    if (residual < bestResidual) {
      bestResidual = residual
      bestGain = gain
    }
  }

  const restoredLinear = new Float64Array(pixels * 3)
  let maskedPixels = 0
  let clippedChannels = 0
  for (let index = 0; index < pixels; index++) {
    const scaledAlpha = Math.min(alpha[index] * bestGain, 0.99)
    const masked = scaledAlpha > 0.002
    if (masked) maskedPixels++
    for (let channel = 0; channel < 3; channel++) {
      const sourceValue = patchLinear[index * 3 + channel]
      const value = masked ? (sourceValue - scaledAlpha) / (1 - scaledAlpha) : sourceValue
      restoredLinear[index * 3 + channel] = value
      if (masked && (value < 0 || value > 1)) clippedChannels++
    }
  }
  const clippedFraction = maskedPixels ? clippedChannels / (maskedPixels * 3) : 0
  const sourceEdge = edgeMagnitude(sourceGray, size, size)
  let coreSum = 0
  let coreCount = 0
  for (let index = 0; index < pixels; index++) {
    if (alpha[index] > 0.05) { coreSum += sourceEdge[index]; coreCount++ }
  }
  const sourceEdgeMean = coreCount ? coreSum / coreCount : 0
  const alphaQualityOk = bestResidual <= 0.001 && clippedFraction <= 0.60 && sourceEdgeMean >= 0.25
  const common = {
    provider: 'Gemini',
    confidence: detection.confidence,
    x,
    y,
    size,
    margin: detection.margin,
    alphaGain: bestGain,
    alphaResidual: bestResidual,
    alphaClippedFraction: clippedFraction,
    sourceEdgeMean,
  }

  if (!alphaQualityOk) {
    // 相关性阈值只说明右下角“像模板”，并不能证明它真是 Gemini 水印。
    // 干净图片也可能偶然命中轮廓；反向 Alpha 后仍高度相关时不允许交给 LaMa 擦除。
    if (!geminiFallbackIsValid(bestResidual)) {
      return { ...common, method: 'gemini-template', status: 'not-found' }
    }
    const rawMask = new Uint8Array(pixels)
    for (let index = 0; index < pixels; index++) rawMask[index] = alpha[index] > 0.012 ? 255 : 0
    const mask = dilate(rawMask, size, size, 7)
    return {
      ...common,
      method: 'gemini-lama',
      status: 'needs-inpaint',
      region: {
        found: true,
        provider: 'Gemini',
        x,
        y,
        width: size,
        height: size,
        mask,
        maskWidth: size,
        maskHeight: size,
        context: 160,
      },
    }
  }

  const patch = new Uint8ClampedArray(pixels * 4)
  for (let index = 0; index < pixels; index++) {
    for (let channel = 0; channel < 3; channel++) {
      patch[index * 4 + channel] = Math.floor(linearToSrgb(restoredLinear[index * 3 + channel]) * 255)
    }
    patch[index * 4 + 3] = sourceAlpha[index]
  }
  return { ...common, method: 'gemini-reverse-alpha', status: 'cleaned', patch }
}

export function geminiAlphaBytes(size) {
  const alpha = ALPHAS.get(size)
  if (!alpha) return null
  const bytes = new Uint8Array(alpha.length)
  for (let index = 0; index < alpha.length; index++) bytes[index] = Math.round(alpha[index] * 255)
  return bytes
}
