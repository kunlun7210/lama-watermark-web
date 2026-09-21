import InferenceWorker from './inference-worker.js?worker&inline'
import { InferenceControllerCore } from './inference-controller-core.js'

export class InferenceController extends InferenceControllerCore {
  constructor() {
    super(() => new InferenceWorker())
  }
}
