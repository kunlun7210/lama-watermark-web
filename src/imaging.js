// 与 OpenCV 对应的小型图像原语（灰度 / 缩放 / 膨胀 / 高斯 / Sobel / Canny / HSV / 模板匹配）
// 目的：把 macOS App（Python + OpenCV）里的水印规则逐条搬到浏览器，几何与阈值保持同源。

export function grayFromRgb(rgba, width, height, out) {
  const gray = out && out.length === width * height ? out : new Float32Array(width * height)
  // 与 cv2.cvtColor(..., COLOR_RGB2GRAY) 一致：先量化到 uint8 再转 float32
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = Math.round(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2])
  }
  return gray
}

export function grayFromRgb8(rgba, width, height, out) {
  const gray = out && out.length === width * height ? out : new Uint8Array(width * height)
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = Math.round(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2])
  }
  return gray
}

/** OpenCV INTER_NEAREST：dst(x,y) = src(floor(x * scale))（OpenCV 不做半像素偏移） */
export function resizeNearest(src, sw, sh, dw, dh, out) {
  const dst = out && out.length === dw * dh ? out : new Uint8Array(dw * dh)
  const sx = sw / dw
  const sy = sh / dh
  for (let y = 0; y < dh; y++) {
    const syi = Math.min(sh - 1, Math.floor(y * sy))
    for (let x = 0; x < dw; x++) {
      const sxi = Math.min(sw - 1, Math.floor(x * sx))
      dst[y * dw + x] = src[syi * sw + sxi]
    }
  }
  return dst
}

/** OpenCV INTER_AREA（缩小时按面积加权平均；放大时退化为双线性） */
export function resizeArea(src, sw, sh, dw, dh, out) {
  const dst = out && out.length === dw * dh ? out : new Float32Array(dw * dh)
  if (dw >= sw || dh >= sh) {
    const sx = sw / dw
    const sy = sh / dh
    for (let y = 0; y < dh; y++) {
      const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5))
      const y0 = Math.floor(fy)
      const y1 = Math.min(sh - 1, y0 + 1)
      const wy = fy - y0
      for (let x = 0; x < dw; x++) {
        const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5))
        const x0 = Math.floor(fx)
        const x1 = Math.min(sw - 1, x0 + 1)
        const wx = fx - x0
        const v00 = src[y0 * sw + x0]
        const v01 = src[y0 * sw + x1]
        const v10 = src[y1 * sw + x0]
        const v11 = src[y1 * sw + x1]
        dst[y * dw + x] = (v00 * (1 - wx) + v01 * wx) * (1 - wy) + (v10 * (1 - wx) + v11 * wx) * wy
      }
    }
    return dst
  }
  const scaleX = sw / dw
  const scaleY = sh / dh
  for (let y = 0; y < dh; y++) {
    const y0 = y * scaleY
    const y1 = Math.min(sh, (y + 1) * scaleY)
    const iy0 = Math.floor(y0)
    const iy1 = Math.max(iy0 + 1, Math.ceil(y1))
    for (let x = 0; x < dw; x++) {
      const x0 = x * scaleX
      const x1 = Math.min(sw, (x + 1) * scaleX)
      const ix0 = Math.floor(x0)
      const ix1 = Math.max(ix0 + 1, Math.ceil(x1))
      let sum = 0
      let weight = 0
      for (let sy = iy0; sy < iy1 && sy < sh; sy++) {
        const hy = Math.min(sy + 1, y1) - Math.max(sy, y0)
        if (hy <= 0) continue
        for (let sx = ix0; sx < ix1 && sx < sw; sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0)
          if (wx <= 0) continue
          const area = wx * hy
          sum += src[sy * sw + sx] * area
          weight += area
        }
      }
      dst[y * dw + x] = weight > 0 ? sum / weight : 0
    }
  }
  return dst
}

/** 方形结构元膨胀；越界像素按 OpenCV dilate 默认（不参与取最大）处理 */
export function dilate(src, width, height, kernel) {
  const dst = new Uint8Array(width * height)
  const r = (kernel - 1) >> 1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = 0
      const y0 = Math.max(0, y - r)
      const y1 = Math.min(height - 1, y + r)
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(width - 1, x + r)
      for (let yy = y0; yy <= y1 && value === 0; yy++) {
        const row = yy * width
        for (let xx = x0; xx <= x1; xx++) {
          if (src[row + xx]) { value = 255; break }
        }
      }
      dst[y * width + x] = value
    }
  }
  return dst
}

function gaussianKernel(sigma) {
  // OpenCV getGaussianKernel：ksize = round(sigma*8+1)|1（float 深度）
  let size = Math.round(sigma * 8 + 1) | 1
  if (size < 3) size = 3
  if (size % 2 === 0) size += 1
  const kernel = new Float32Array(size)
  const half = (size - 1) / 2
  let sum = 0
  const scale2 = -1 / (2 * sigma * sigma)
  for (let i = 0; i < size; i++) {
    const x = i - half
    kernel[i] = Math.exp(x * x * scale2)
    sum += kernel[i]
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum
  return kernel
}

const reflect101 = (i, n) => {
  if (n === 1) return 0
  while (i < 0 || i >= n) {
    if (i < 0) i = -i
    else i = 2 * n - 2 - i
  }
  return i
}

export function gaussianBlur(src, width, height, sigma, out) {
  const dst = out && out.length === src.length ? out : new Float32Array(src.length)
  const kernel = gaussianKernel(Math.max(0.1, sigma))
  const half = (kernel.length - 1) / 2
  const tmp = new Float32Array(src.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let k = -half; k <= half; k++) {
        sum += kernel[k + half] * src[y * width + reflect101(x + k, width)]
      }
      tmp[y * width + x] = sum
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let k = -half; k <= half; k++) {
        sum += kernel[k + half] * tmp[reflect101(y + k, height) * width + x]
      }
      dst[y * width + x] = sum
    }
  }
  return dst
}

/** 3x3 Sobel 梯度幅值（L1），与 cv2.Canny 默认的 |Gx|+|Gy| 一致 */
export function sobelL1(src, width, height) {
  const mag = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xm = reflect101(x - 1, width)
      const xp = reflect101(x + 1, width)
      const ym = reflect101(y - 1, height)
      const yp = reflect101(y + 1, height)
      const tl = src[ym * width + xm], tc = src[ym * width + x], tr = src[ym * width + xp]
      const ml = src[y * width + xm], mr = src[y * width + xp]
      const bl = src[yp * width + xm], bc = src[yp * width + x], br = src[yp * width + xp]
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl)
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr)
      mag[y * width + x] = Math.abs(gx) + Math.abs(gy)
    }
  }
  return mag
}

/** cv2.Canny(gray_u8, low, high)：Sobel → 非极大值抑制 → 双阈值 + 滞后连接 */
export function canny(gray, width, height, low, high, out) {
  const gx = new Float32Array(width * height)
  const gy = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xm = reflect101(x - 1, width)
      const xp = reflect101(x + 1, width)
      const ym = reflect101(y - 1, height)
      const yp = reflect101(y + 1, height)
      const tl = gray[ym * width + xm], tc = gray[ym * width + x], tr = gray[ym * width + xp]
      const ml = gray[y * width + xm], mr = gray[y * width + xp]
      const bl = gray[yp * width + xm], bc = gray[yp * width + x], br = gray[yp * width + xp]
      gx[y * width + x] = (tr + 2 * mr + br) - (tl + 2 * ml + bl)
      gy[y * width + x] = (bl + 2 * bc + br) - (tl + 2 * tc + tr)
    }
  }
  const mag = new Float32Array(width * height)
  for (let i = 0; i < mag.length; i++) mag[i] = Math.abs(gx[i]) + Math.abs(gy[i])

  // 非极大值抑制：按量化方向（0/45/90/135）比较相邻两点
  const thin = new Float32Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const m = mag[i]
      if (m === 0) continue
      const ax = Math.abs(gx[i])
      const ay = Math.abs(gy[i])
      let n1, n2
      if (ay <= ax * 0.4142) { n1 = mag[i - 1]; n2 = mag[i + 1] }
      else if (ay >= ax * 2.4142) { n1 = mag[i - width]; n2 = mag[i + width] }
      else if (gx[i] * gy[i] > 0) { n1 = mag[i - width - 1]; n2 = mag[i + width + 1] }
      else { n1 = mag[i - width + 1]; n2 = mag[i + width - 1] }
      if (m >= n1 && m >= n2) thin[i] = m
    }
  }

  const edges = out && out.length === width * height ? out : new Uint8Array(width * height)
  edges.fill(0)
  const stack = []
  for (let i = 0; i < thin.length; i++) {
    if (thin[i] >= high) { edges[i] = 255; stack.push(i) }
  }
  while (stack.length) {
    const i = stack.pop()
    const x = i % width
    const y = (i - x) / width
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 1 || ny < 1 || nx >= width - 1 || ny >= height - 1) continue
        const j = ny * width + nx
        if (edges[j]) continue
        if (thin[j] >= low) { edges[j] = 255; stack.push(j) }
      }
    }
  }
  return edges
}

/** RGB → HSV，H 取 0..179（与 cv2.COLOR_RGB2HSV 同尺度），S/V 取 0..255 */
export function hsvFromRgb(rgba, width, height, outH, outS, outV) {
  const h = outH || new Uint8Array(width * height)
  const s = outS || new Uint8Array(width * height)
  const v = outV || new Uint8Array(width * height)
  for (let i = 0, p = 0; i < h.length; i++, p += 4) {
    const r = rgba[p]
    const g = rgba[p + 1]
    const b = rgba[p + 2]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const delta = max - min
    let hue = 0
    if (delta !== 0) {
      if (max === r) hue = 60 * (((g - b) / delta) % 6)
      else if (max === g) hue = 60 * ((b - r) / delta + 2)
      else hue = 60 * ((r - g) / delta + 4)
      if (hue < 0) hue += 360
    }
    h[i] = Math.round(hue / 2)
    s[i] = max === 0 ? 0 : Math.round((delta / max) * 255)
    v[i] = max
  }
  return { h, s, v }
}

/** 两个等尺寸数组的相关系数（等价 cv2.TM_CCOEFF_NORMED 的单点结果） */
export function pearson(a, b) {
  let ma = 0
  let mb = 0
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i] }
  ma /= a.length
  mb /= b.length
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma
    const y = b[i] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  if (da <= 0 || db <= 0) return 0
  return num / Math.sqrt(da * db)
}

/**
 * 在 search 内滑动 kernel（kernel 为稀疏权重：内部 +1/N，外环 -1/M），返回最大响应与位置。
 * 等价 cv2.matchTemplate(search, kernel, TM_CCORR) + minMaxLoc。
 */
export function ccorrMax(search, sw, sh, kernel, kw, kh) {
  // 收集非零核元素，避免全核遍历
  const points = []
  for (let y = 0; y < kh; y++) {
    for (let x = 0; x < kw; x++) {
      const w = kernel[y * kw + x]
      if (w !== 0) points.push([y, x, w])
    }
  }
  const outW = sw - kw + 1
  const outH = sh - kh + 1
  let best = -Infinity
  let bestX = 0
  let bestY = 0
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let sum = 0
      for (let i = 0; i < points.length; i++) {
        const [py, px, w] = points[i]
        sum += w * search[(y + py) * sw + (x + px)]
      }
      if (sum > best) { best = sum; bestX = x; bestY = y }
    }
  }
  return { value: best === -Infinity ? 0 : best, x: bestX, y: bestY, outW, outH }
}

/** 同 ccorrMax，但返回最小值（元宝需要正负极性取绝对值更大者） */
export function ccorrMinMax(search, sw, sh, kernel, kw, kh) {
  const points = []
  for (let y = 0; y < kh; y++) {
    for (let x = 0; x < kw; x++) {
      const w = kernel[y * kw + x]
      if (w !== 0) points.push([y, x, w])
    }
  }
  const outW = sw - kw + 1
  const outH = sh - kh + 1
  let maxV = -Infinity
  let minV = Infinity
  let maxX = 0
  let maxY = 0
  let minX = 0
  let minY = 0
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let sum = 0
      for (let i = 0; i < points.length; i++) {
        const [py, px, w] = points[i]
        sum += w * search[(y + py) * sw + (x + px)]
      }
      if (sum > maxV) { maxV = sum; maxX = x; maxY = y }
      if (sum < minV) { minV = sum; minX = x; minY = y }
    }
  }
  return { max: maxV === -Infinity ? 0 : maxV, min: minV === Infinity ? 0 : minV, maxX, maxY, minX, minY }
}

/** NCC 滑动匹配（用于小红书徽标：边缘图 vs 模板边），返回最高分与位置 */
export function nccMax(search, sw, sh, template, kw, kh) {
  const outW = sw - kw + 1
  const outH = sh - kh + 1
  let tMean = 0
  for (let i = 0; i < template.length; i++) tMean += template[i]
  tMean /= template.length
  const tCentered = new Float32Array(template.length)
  let tNorm = 0
  for (let i = 0; i < template.length; i++) {
    tCentered[i] = template[i] - tMean
    tNorm += tCentered[i] * tCentered[i]
  }
  tNorm = Math.sqrt(tNorm)
  let best = -Infinity
  let bestX = 0
  let bestY = 0
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let sum = 0
      let sumSq = 0
      for (let ty = 0; ty < kh; ty++) {
        const row = (y + ty) * sw + x
        for (let tx = 0; tx < kw; tx++) {
          const v = search[row + tx]
          sum += v
          sumSq += v * v
        }
      }
      const n = kw * kh
      const mean = sum / n
      const varSum = sumSq - n * mean * mean
      if (varSum <= 1e-10 || tNorm <= 1e-10) continue
      let num = 0
      for (let ty = 0; ty < kh; ty++) {
        const row = (y + ty) * sw + x
        for (let tx = 0; tx < kw; tx++) {
          num += (search[row + tx] - mean) * tCentered[ty * kw + tx]
        }
      }
      const score = num / (Math.sqrt(varSum) * tNorm)
      if (score > best) { best = score; bestX = x; bestY = y }
    }
  }
  return { value: best === -Infinity ? 0 : best, x: bestX, y: bestY }
}
