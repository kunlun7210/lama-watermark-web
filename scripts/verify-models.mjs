import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const expected = {
  int8: {
    version: 'lama-512-int8-418036c6b541e526cdbb0bead1ec3a87dabede53',
    totalSize: 62074990,
    sha256: 'cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe',
    inputLayout: 'masked-rgb-mask',
  },
  fp32: {
    version: 'lama-fp32-c3c0c9e468934d62e79c329e35d82dd09ff8c444',
    totalSize: 208044816,
    sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6',
    inputLayout: 'image-mask',
  },
}

for (const [variant, pinned] of Object.entries(expected)) {
  const directory = path.resolve('public/models', variant)
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
  for (const [key, value] of Object.entries(pinned)) {
    if (manifest[key] !== value) throw new Error(`${variant}: ${key} is not pinned to the reviewed value`)
  }
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length === 0) throw new Error(`${variant}: missing chunks`)
  const hash = createHash('sha256')
  let totalSize = 0
  for (const [index, chunk] of manifest.chunks.entries()) {
    const expectedName = `lama.part.${String(index).padStart(3, '0')}.bin`
    if (chunk.file !== expectedName) throw new Error(`${variant}: unexpected chunk name ${chunk.file}`)
    if (!Number.isSafeInteger(chunk.size) || chunk.size <= 0 || chunk.size > 16 * 1024 * 1024) {
      throw new Error(`${variant}/${chunk.file}: invalid chunk size`)
    }
    const bytes = await readFile(path.join(directory, chunk.file))
    if (bytes.byteLength !== chunk.size) throw new Error(`${variant}/${chunk.file}: size mismatch`)
    hash.update(bytes)
    totalSize += bytes.byteLength
  }
  if (totalSize !== manifest.totalSize) throw new Error(`${variant}: chunk sizes do not add up`)
  const files = await readdir(directory)
  const expectedFiles = new Set(manifest.chunks.map(chunk => chunk.file))
  const unexpected = files.filter(file => file.endsWith('.bin') && !expectedFiles.has(file))
  if (unexpected.length) throw new Error(`${variant}: unexpected model chunks: ${unexpected.join(', ')}`)
  const digest = hash.digest('hex')
  if (digest !== pinned.sha256) throw new Error(`${variant}: binary SHA-256 is not the reviewed value`)
  console.log(`${variant}: ${manifest.chunks.length} reviewed chunks, ${totalSize} bytes, SHA-256 ${digest}`)
}
