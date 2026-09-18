import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

for (const variant of ['int8', 'fp32']) {
  const directory = path.resolve('public/models', variant)
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
  const hash = createHash('sha256')
  let totalSize = 0
  for (const chunk of manifest.chunks) {
    const bytes = await readFile(path.join(directory, chunk.file))
    if (bytes.byteLength !== chunk.size) throw new Error(`${variant}/${chunk.file}: size mismatch`)
    hash.update(bytes)
    totalSize += bytes.byteLength
  }
  if (totalSize !== manifest.totalSize) throw new Error(`${variant}: total size mismatch`)
  const digest = hash.digest('hex')
  if (digest !== manifest.sha256) throw new Error(`${variant}: SHA-256 mismatch`)
  console.log(`${variant}: ${totalSize} bytes, SHA-256 ${digest}`)
}
