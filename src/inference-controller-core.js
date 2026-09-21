export class InferenceControllerCore {
  constructor(createWorker) {
    if (typeof createWorker !== 'function') throw new TypeError('createWorker 必须是函数')
    this.createWorker = createWorker
    this.worker = null
    this.generation = 0
    this.nextRequestId = 1
    this.ready = null
    this.readyReject = null
    this.readyTimer = null
    this.pending = new Map()
    this.modelId = null
    this.threads = 1
  }

  async initialise({ model, modelBytes, threads, ortBase, timeoutMs = 120000 }) {
    this.terminate(new Error('模型已切换，旧推理已终止'))
    const generation = ++this.generation
    // GitHub Pages 通过 coi-serviceworker 补 COOP/COEP。部分 Chrome/Safari 版本会让
    // 由页面再请求的 module Worker 卡在加载中；调用方传入内联 Worker 避开第二次网络请求。
    const worker = this.createWorker()
    this.worker = worker
    this.modelId = model.id
    this.threads = threads

    this.ready = new Promise((resolve, reject) => {
      let settled = false
      const clearReadyState = () => {
        if (this.readyTimer) clearTimeout(this.readyTimer)
        this.readyTimer = null
        this.readyReject = null
      }
      const resolveOnce = value => {
        if (settled) return
        settled = true
        clearReadyState()
        resolve(value)
      }
      const rejectOnce = error => {
        if (settled) return
        settled = true
        clearReadyState()
        reject(error)
      }
      this.readyReject = rejectOnce
      this.readyTimer = setTimeout(() => {
        const error = new Error(`模型初始化超过 ${Math.round(timeoutMs / 1000)} 秒，已终止推理线程`)
        error.name = 'SessionInitTimeoutError'
        this.terminate(error)
      }, timeoutMs)

      const fail = error => {
        if (this.worker === worker) this.terminate(error)
        else rejectOnce(error)
      }
      worker.onerror = event => fail(new Error(event.message || '推理线程启动失败'))
      worker.onmessageerror = () => fail(new Error('推理线程通信失败'))
      worker.onmessage = event => this.#handleMessage(worker, generation, event.data, resolveOnce, rejectOnce)
    })

    const ready = this.ready
    const buffer = modelBytes.buffer.slice(modelBytes.byteOffset, modelBytes.byteOffset + modelBytes.byteLength)
    try {
      worker.postMessage({
        type: 'init', generation, model: { id: model.id, inputLayout: model.inputLayout },
        modelBuffer: buffer, threads, ortBase,
      }, [buffer])
    } catch (error) {
      this.terminate(error)
    }
    await ready
    return { modelId: model.id, threads }
  }

  async run(image, mask, timeoutMs) {
    if (!this.worker || !this.ready) throw new Error('模型尚未初始化')
    await this.ready
    const worker = this.worker
    const requestId = this.nextRequestId++
    const imageBuffer = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength)
    const maskBuffer = mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return
        this.pending.delete(requestId)
        const error = new Error(`本张推理超过 ${Math.round(timeoutMs / 1000)} 秒未返回，已终止推理线程`)
        error.name = 'InferenceTimeoutError'
        this.terminate(error)
        reject(error)
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        worker.postMessage({ type: 'run', requestId, imageBuffer, maskBuffer }, [imageBuffer, maskBuffer])
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        this.terminate(error)
        reject(error)
      }
    })
  }

  terminate(reason = new Error('推理线程已终止')) {
    const rejectReady = this.readyReject
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
    this.readyReject = null
    if (this.worker) this.worker.terminate()
    this.worker = null
    this.ready = null
    this.modelId = null
    rejectReady?.(reason)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.pending.clear()
  }

  #handleMessage(worker, generation, message, resolveReady, rejectReady) {
    if (worker !== this.worker || generation !== this.generation) return
    if (message.type === 'ready') {
      resolveReady(message)
      return
    }
    if (message.type === 'result') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      this.pending.delete(message.requestId)
      clearTimeout(pending.timer)
      pending.resolve(new Float32Array(message.outputBuffer))
      return
    }
    if (message.type === 'error') {
      const error = new Error(message.error?.message || '推理失败')
      error.name = message.error?.name || 'Error'
      error.stack = message.error?.stack || error.stack
      if (message.requestId) {
        const pending = this.pending.get(message.requestId)
        if (!pending) return
        this.pending.delete(message.requestId)
        clearTimeout(pending.timer)
        pending.reject(error)
      } else {
        this.terminate(error)
        rejectReady(error)
      }
    }
  }
}
