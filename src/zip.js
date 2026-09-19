// 极简 ZIP 打包（STORE 方法，不压缩）。PNG 本身已压缩，省掉 deflate 更快也更省内存。
// 用 Blob 分片拼装：文件内容不复制进 JS 堆，只有当前文件算 CRC 时需要一小块临时缓冲。

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f)
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time, day }
}

class Writer {
  constructor(size) { this.view = new DataView(new ArrayBuffer(size)); this.offset = 0 }
  u16(value) { this.view.setUint16(this.offset, value, true); this.offset += 2 }
  u32(value) { this.view.setUint32(this.offset, value >>> 0, true); this.offset += 4 }
  get bytes() { return new Uint8Array(this.view.buffer) }
}

/**
 * @param {{name: string, blob: Blob}[]} entries
 * @returns {Promise<Blob>} zip 文件
 */
export async function buildZip(entries) {
  const encoder = new TextEncoder()
  const { time, day } = dosDateTime(new Date())
  const parts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const data = new Uint8Array(await entry.blob.arrayBuffer())
    const checksum = crc32(data)

    const header = new Writer(30)
    header.u32(0x04034b50)
    header.u16(20)          // version needed
    header.u16(0x0800)      // UTF-8 文件名标志
    header.u16(0)           // method: store
    header.u16(time)
    header.u16(day)
    header.u32(checksum)
    header.u32(data.length)
    header.u32(data.length)
    header.u16(nameBytes.length)
    header.u16(0)
    parts.push(header.bytes, nameBytes, entry.blob)

    const central = new Writer(46)
    central.u32(0x02014b50)
    central.u16(20)
    central.u16(20)
    central.u16(0x0800)
    central.u16(0)
    central.u16(time)
    central.u16(day)
    central.u32(checksum)
    central.u32(data.length)
    central.u32(data.length)
    central.u16(nameBytes.length)
    central.u16(0)
    central.u16(0)
    central.u16(0)
    central.u16(0)
    central.u32(0)
    central.u32(offset)
    centralParts.push(central.bytes, nameBytes)

    offset += 30 + nameBytes.length + data.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const end = new Writer(22)
  end.u32(0x06054b50)
  end.u16(0)
  end.u16(0)
  end.u16(entries.length)
  end.u16(entries.length)
  end.u32(centralSize)
  end.u32(offset)
  end.u16(0)

  return new Blob([...parts, ...centralParts, end.bytes], { type: 'application/zip' })
}
