import * as ort from 'onnxruntime-web/wasm'

const MODEL_SIZE = 512
let session = null
let model = null

function serialiseError(error) {
  return {
    name: error?.name || 'Error',
    message: String(error?.message || error || '推理失败'),
    stack: error?.stack || '',
  }
}

function createFeeds(image, mask) {
  if (model.inputLayout === 'masked-rgb-mask') {
    const plane = MODEL_SIZE * MODEL_SIZE
    const combined = new Float32Array(plane * 4)
    for (let channel = 0; channel < 3; channel++) {
      const channelOffset = channel * plane
      for (let index = 0; index < plane; index++) {
        combined[channelOffset + index] = image[channelOffset + index] * (1 - mask[index])
      }
    }
    combined.set(mask, plane * 3)
    const tensor = new ort.Tensor('float32', combined, [1, 4, MODEL_SIZE, MODEL_SIZE])
    return { feeds: { [session.inputNames[0]]: tensor }, tensors: [tensor] }
  }

  const imageTensor = new ort.Tensor('float32', image, [1, 3, MODEL_SIZE, MODEL_SIZE])
  const maskTensor = new ort.Tensor('float32', mask, [1, 1, MODEL_SIZE, MODEL_SIZE])
  return {
    feeds: { [session.inputNames[0]]: imageTensor, [session.inputNames[1]]: maskTensor },
    tensors: [imageTensor, maskTensor],
  }
}

async function initialise(message) {
  model = message.model
  ort.env.wasm.wasmPaths = {
    wasm: `${message.ortBase}ort-wasm-simd-threaded.wasm`,
    mjs: `${message.ortBase}ort-wasm-simd-threaded.mjs`,
  }
  ort.env.wasm.numThreads = message.threads
  ort.env.wasm.simd = true
  ort.env.logLevel = 'warning'
  session = await ort.InferenceSession.create(new Uint8Array(message.modelBuffer), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    enableCpuMemArena: true,
    enableMemPattern: true,
  })
  self.postMessage({ type: 'ready', generation: message.generation, modelId: model.id, threads: message.threads })
}

async function run(message) {
  if (!session || !model) throw new Error('模型尚未初始化')
  const image = new Float32Array(message.imageBuffer)
  const mask = new Float32Array(message.maskBuffer)
  const { feeds, tensors } = createFeeds(image, mask)
  let outputTensor = null
  try {
    const result = await session.run(feeds)
    outputTensor = result[session.outputNames[0]]
    const output = new Float32Array(outputTensor.data)
    self.postMessage({ type: 'result', requestId: message.requestId, outputBuffer: output.buffer }, [output.buffer])
  } finally {
    tensors.forEach(tensor => tensor.dispose?.())
    outputTensor?.dispose?.()
  }
}

self.onmessage = async event => {
  const message = event.data
  try {
    if (message.type === 'init') await initialise(message)
    else if (message.type === 'run') await run(message)
    else if (message.type === 'release') {
      await session?.release?.()
      session = null
      model = null
      self.postMessage({ type: 'released' })
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      generation: message.generation,
      requestId: message.requestId,
      error: serialiseError(error),
    })
  }
}
