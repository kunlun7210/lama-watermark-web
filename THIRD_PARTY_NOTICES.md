# Third-party notices

This repository redistributes or uses the following components:

- LaMa FP32 ONNX model from `Carve/LaMa-ONNX`, Apache License 2.0.
- LaMa 512 INT8 ONNX model from `g-ronimo/lama`, Apache License 2.0.
- ONNX Runtime Web 1.26.0, MIT License.
- `coi-serviceworker` 0.1.7 by Guido Zuidhof, MIT License.
- PaddleOCR.js 0.4.2 and PP-OCRv5 mobile detection/recognition model archives, Apache License 2.0. The two model archives are stored under `public/ocr/` and loaded locally in the browser only when OCR fallback is needed.
- OpenCV.js from `@techstark/opencv-js`, Apache License 2.0; `clipper-lib`, Boost Software License; `js-yaml`, MIT License. These are dependencies of PaddleOCR.js.

The watermark detection rules and the bitmap templates in `src/maskData.js`,
`src/gemini-alpha-data.js` and `public/templates/` are ported from the same
author's local macOS tool "Remove Watermark" (WatermarkBatchLite); the Gemini
Alpha templates come from its 0.7.2 release. They are plain bitmap data
distributed with this repository — no third-party model weights are involved,
and none of those existing templates require an additional download at runtime.

The model manifests in `public/models/` record the upstream source, fixed
version, byte size and SHA-256 digest used by this build.

License texts are included in the `licenses/` directory.
