// Contrast Limited Adaptive Histogram Equalization for an OCR corner crop.
// Return a new grayscale RGBA buffer so the original image and repair input
// are never modified by this recognition-only preprocessing pass.
export function claheGrayRgba(rgba, width, height, { tileSize = 64, clipLimit = 2 } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || rgba.length !== width * height * 4) throw new RangeError('Invalid CLAHE image dimensions')
  const tilesX = Math.max(1, Math.min(8, Math.round(width / tileSize)))
  const tilesY = Math.max(1, Math.min(8, Math.round(height / tileSize)))
  const gray = new Uint8Array(width * height)
  for (let pixel = 0; pixel < gray.length; pixel++) {
    const at = pixel * 4
    gray[pixel] = (77 * rgba[at] + 150 * rgba[at + 1] + 29 * rgba[at + 2]) >> 8
  }

  const lookup = new Array(tilesX * tilesY)
  for (let ty = 0; ty < tilesY; ty++) {
    const y0 = Math.floor(ty * height / tilesY)
    const y1 = Math.floor((ty + 1) * height / tilesY)
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = Math.floor(tx * width / tilesX)
      const x1 = Math.floor((tx + 1) * width / tilesX)
      const area = (x1 - x0) * (y1 - y0)
      const hist = new Uint32Array(256)
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) hist[gray[y * width + x]]++
      }
      const cap = Math.max(1, Math.round(clipLimit * area / 256))
      let excess = 0
      for (let bin = 0; bin < 256; bin++) {
        if (hist[bin] > cap) { excess += hist[bin] - cap; hist[bin] = cap }
      }
      const uniform = Math.floor(excess / 256)
      const remainder = excess % 256
      for (let bin = 0; bin < 256; bin++) hist[bin] += uniform
      for (let index = 0; index < remainder; index++) hist[Math.floor(index * 256 / remainder)]++
      const lut = new Uint8Array(256)
      let cumulative = 0
      for (let bin = 0; bin < 256; bin++) {
        cumulative += hist[bin]
        lut[bin] = Math.min(255, Math.round(cumulative * 255 / area))
      }
      lookup[ty * tilesX + tx] = lut
    }
  }

  const output = new Uint8ClampedArray(rgba.length)
  for (let y = 0; y < height; y++) {
    const gy = (y + 0.5) * tilesY / height - 0.5
    const top = Math.max(0, Math.min(tilesY - 1, Math.floor(gy)))
    const bottom = Math.min(tilesY - 1, top + 1)
    const wy = Math.max(0, Math.min(1, gy - top))
    for (let x = 0; x < width; x++) {
      const gx = (x + 0.5) * tilesX / width - 0.5
      const left = Math.max(0, Math.min(tilesX - 1, Math.floor(gx)))
      const right = Math.min(tilesX - 1, left + 1)
      const wx = Math.max(0, Math.min(1, gx - left))
      const pixel = y * width + x
      const level = gray[pixel]
      const value = Math.round(
        (lookup[top * tilesX + left][level] * (1 - wx) + lookup[top * tilesX + right][level] * wx) * (1 - wy)
        + (lookup[bottom * tilesX + left][level] * (1 - wx) + lookup[bottom * tilesX + right][level] * wx) * wy,
      )
      const at = pixel * 4
      output[at] = output[at + 1] = output[at + 2] = value
      output[at + 3] = rgba[at + 3]
    }
  }
  return output
}

export function claheCanvas(source) {
  const { width, height } = source
  const context = source.getContext('2d', { willReadFrequently: true })
  const input = context.getImageData(0, 0, width, height)
  const output = document.createElement('canvas')
  output.width = width
  output.height = height
  output.getContext('2d').putImageData(
    new ImageData(claheGrayRgba(input.data, width, height), width, height), 0, 0,
  )
  return output
}
