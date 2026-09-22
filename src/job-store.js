// 继续使用原 lama-watermark-web 的数据库和记录格式。这样同一 Pages 网址升级到
// v1.0.0 后，可以直接恢复旧版正在处理的批次和已经落盘的结果。
const DB_NAME = 'lama-iphone-poc'
const DB_VERSION = 2
const BATCH_STORE = 'images'
const RESULT_STORE = 'results'
const CURRENT_BATCH = 'batch'

export const BATCH_LIMIT_COUNT = 40
export const BATCH_LIMIT_BYTES = 220 * 1024 * 1024
const MIN_FREE_BYTES = 48 * 1024 * 1024
const QUOTA_HEADROOM = 0.90

export class StorageCapacityError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StorageCapacityError'
  }
}

export function batchLimitReason(items) {
  const totalBytes = items.reduce((sum, item) => sum + (item?.file?.size || 0), 0)
  if (items.length > BATCH_LIMIT_COUNT) return `超过 ${BATCH_LIMIT_COUNT} 张`
  if (totalBytes > BATCH_LIMIT_BYTES) return `原图超过 ${Math.round(BATCH_LIMIT_BYTES / 1048576)}MB`
  return ''
}

function requestValue(request, fallback) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result ?? fallback)
    request.onerror = () => reject(request.error || new Error('本地存储读取失败'))
  })
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('本地存储写入失败'))
    transaction.onabort = () => reject(transaction.error || new Error('本地存储写入中止'))
  })
}

export function openJobDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('浏览器不支持 IndexedDB'))
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(BATCH_STORE)) database.createObjectStore(BATCH_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(RESULT_STORE)) database.createObjectStore(RESULT_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('无法打开任务缓存'))
  })
}

async function ensureCapacity(extraBytes) {
  if (!navigator.storage?.estimate) return
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  if (!quota) return
  const usable = Math.max(0, quota * QUOTA_HEADROOM - usage)
  if (usable < extraBytes + MIN_FREE_BYTES) {
    const freeMb = Math.max(0, usable / 1048576).toFixed(0)
    throw new StorageCapacityError(`浏览器可用空间约 ${freeMb}MB，无法安全保存本次结果`)
  }
}

export async function saveBatch(items) {
  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0)
  const limitReason = batchLimitReason(items)
  if (limitReason) {
    return {
      saved: false,
      reason: `${limitReason}，已保留现有任务和结果`,
    }
  }
  await ensureCapacity(totalBytes)
  const database = await openJobDatabase()
  try {
    const transaction = database.transaction(BATCH_STORE, 'readwrite')
    transaction.objectStore(BATCH_STORE).put({
      id: CURRENT_BATCH,
      savedAt: Date.now(),
      ids: items.map(item => item.id),
      files: items.map(item => ({
        name: item.name,
        type: item.file.type,
        lastModified: item.file.lastModified,
        blob: item.file,
      })),
    })
    await transactionDone(transaction)
    return { saved: true, totalBytes }
  } finally {
    database.close()
  }
}

export async function loadBatch() {
  const database = await openJobDatabase()
  try {
    const transaction = database.transaction(BATCH_STORE, 'readonly')
    const record = await requestValue(transaction.objectStore(BATCH_STORE).get(CURRENT_BATCH), null)
    if (!record?.files?.length) return []
    const ids = Array.isArray(record.ids) ? record.ids : []
    return record.files.map((entry, index) => ({
      id: ids[index] || null,
      file: new File([entry.blob], entry.name, {
        type: entry.type || entry.blob.type,
        lastModified: entry.lastModified || Date.now(),
      }),
    }))
  } finally {
    database.close()
  }
}

export async function saveResult(item) {
  if (!item?.blob) throw new Error('没有可保存的处理结果')
  await ensureCapacity(item.blob.size)
  const database = await openJobDatabase()
  try {
    const transaction = database.transaction(RESULT_STORE, 'readwrite')
    transaction.objectStore(RESULT_STORE).put({
      id: item.id,
      savedAt: Date.now(),
      status: item.status,
      modelId: item.modelId,
      outputBlob: item.blob,
      outputExt: item.outputExt,
      provider: item.provider,
      regions: item.regions,
      elapsed: item.elapsed,
      inferSeconds: item.inferSeconds,
      metrics: item.metrics,
      width: item.width,
      height: item.height,
    })
    await transactionDone(transaction)
    return true
  } finally {
    database.close()
  }
}

export async function loadResult(id) {
  const database = await openJobDatabase()
  try {
    const transaction = database.transaction(RESULT_STORE, 'readonly')
    return await requestValue(transaction.objectStore(RESULT_STORE).get(id), null)
  } finally {
    database.close()
  }
}

export async function deleteResult(id) {
  const database = await openJobDatabase()
  try {
    const transaction = database.transaction(RESULT_STORE, 'readwrite')
    transaction.objectStore(RESULT_STORE).delete(id)
    await transactionDone(transaction)
  } finally {
    database.close()
  }
}

export async function clearStoredJob() {
  const database = await openJobDatabase()
  try {
    const transaction = database.transaction([BATCH_STORE, RESULT_STORE], 'readwrite')
    transaction.objectStore(BATCH_STORE).clear()
    transaction.objectStore(RESULT_STORE).clear()
    await transactionDone(transaction)
  } finally {
    database.close()
  }
}

export async function storageSummary() {
  if (!navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota, free: Math.max(0, quota - usage) }
}
