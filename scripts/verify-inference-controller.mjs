import { InferenceControllerCore } from '../src/inference-controller-core.js'

class FakeWorker {
  constructor(mode = 'ready') {
    this.mode = mode
    this.terminated = false
  }
  postMessage(message) {
    if (message.type === 'init' && this.mode === 'ready') {
      queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }))
    }
  }
  terminate() { this.terminated = true }
}

const bytes = new Uint8Array([1, 2, 3])
const model = { id: 'test', inputLayout: 'image-mask' }

const readyWorker = new FakeWorker()
const readyController = new InferenceControllerCore(() => readyWorker)
await readyController.initialise({ model, modelBytes: bytes, threads: 2, ortBase: '/', timeoutMs: 50 })
if (readyWorker.terminated || readyController.modelId !== 'test') throw new Error('正常初始化不应终止 Worker')
readyController.terminate()

const stalledWorker = new FakeWorker('stall')
const stalledController = new InferenceControllerCore(() => stalledWorker)
await stalledController.initialise({ model, modelBytes: bytes, threads: 1, ortBase: '/', timeoutMs: 10 })
  .then(() => { throw new Error('卡住的初始化不应成功') })
  .catch(error => {
    if (error.name !== 'SessionInitTimeoutError') throw error
  })
if (!stalledWorker.terminated || stalledController.worker) throw new Error('初始化超时必须终止并释放 Worker')

const errorWorker = new FakeWorker('error')
errorWorker.postMessage = message => {
  if (message.type === 'init') queueMicrotask(() => errorWorker.onmessage?.({ data: { type: 'error', error: { message: '初始化失败' } } }))
}
const errorController = new InferenceControllerCore(() => errorWorker)
await errorController.initialise({ model, modelBytes: bytes, threads: 1, ortBase: '/', timeoutMs: 50 })
  .then(() => { throw new Error('初始化错误不应成功') })
  .catch(error => {
    if (error.message !== '初始化失败') throw error
  })
if (!errorWorker.terminated || errorController.worker) throw new Error('初始化错误必须终止并释放 Worker')

const cancelledWorker = new FakeWorker('stall')
const cancelledController = new InferenceControllerCore(() => cancelledWorker)
const cancelled = cancelledController.initialise({ model, modelBytes: bytes, threads: 1, ortBase: '/', timeoutMs: 1000 })
const reason = new Error('主动重建')
cancelledController.terminate(reason)
await cancelled.then(() => { throw new Error('被终止的初始化不应成功') }).catch(error => {
  if (error !== reason) throw error
})
if (!cancelledWorker.terminated) throw new Error('主动重建必须终止初始化中的 Worker')

console.log('inference-controller: ready, init failure, timeout and external termination verified')
