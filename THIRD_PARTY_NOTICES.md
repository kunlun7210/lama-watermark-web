# Third-party notices

This repository redistributes or uses the following components:

- LaMa FP32 ONNX model from `Carve/LaMa-ONNX`, Apache License 2.0.
- LaMa 512 INT8 ONNX model from `g-ronimo/lama`, Apache License 2.0.
- ONNX Runtime Web 1.26.0, MIT License.
- `coi-serviceworker` 0.1.7 by Guido Zuidhof, MIT License.

The watermark detection rules and the bitmap templates in `src/maskData.js`,
`src/gemini-alpha-data.js` and `public/templates/` are ported from the same
author's local macOS tool "Remove Watermark" (WatermarkBatchLite); the Gemini
Alpha templates come from its 0.7.2 release. They are plain bitmap data
distributed with this repository — no third-party model weights are involved,
and none of them require an additional download at runtime.

The model manifests in `public/models/` record the upstream source, fixed
version, byte size and SHA-256 digest used by this build.

License texts are included in the `licenses/` directory.
