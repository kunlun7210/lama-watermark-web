# LaMa iPhone Web Test

这是一个纯浏览器 LaMa 去水印实机测试页。图片和推理都留在浏览器内，不需要后端服务器，也不向网站上传图片。

当前版本只处理豆包生成图右下角的固定水印，一次一张。它用于比较两个 512×512 ONNX 模型在 iPhone Safari 上的内存、速度和结果，为后续批量版选择模型。

## 两个模型

| 选项 | 下载量 | 输入 | 用途 |
| --- | ---: | --- | --- |
| INT8 | 62,074,990 bytes | `[1,4,512,512]` | 降低首次下载和内存压力 |
| FP32 | 208,044,816 bytes | 图像 `[1,3,512,512]` + 遮罩 `[1,1,512,512]` | 接近现有 Mac 版的画质基准 |

两个模型都按不超过 16MiB 的同源静态分段发布。网页会显示实时下载速度和预计剩余时间，并把单个分段的超时提高到 3 分钟。切换模型时会先释放当前会话，避免同时常驻两个模型。

## 已验证

- 真实测试集共 79 个文件，其中 60 张由现有精确规则找到水印并完成两个模型的本地推理。
- INT8 与 FP32 在 60 张修复区域内的平均绝对像素差为 2.35/255，中位数为 2.00/255，平均 PSNR 为 39.06dB。
- Node ONNX Runtime Web WASM：FP32 单线程约 14.8 秒、四线程约 4.7 秒；INT8 单线程约 13.9 秒、四线程约 6.1 秒。
- Chromium 页面实跑同一张 1728×2304 豆包图：INT8 推理 3.4 秒，FP32 推理 4.5 秒；两个模型均输出 1728×2304 PNG，四个 WASM 线程，`crossOriginIsolated=true`。
- 所选原图保存在 IndexedDB；Safari 因切到后台而重载时会自动恢复。

完整记录见 [EVALUATION.md](./EVALUATION.md)。

## 本地运行

```bash
npm install
npm run dev
```

Vite 本地服务直接返回 COOP/COEP 响应头。GitHub Pages 不支持自定义这些响应头，因此生产页使用固定版本的 `coi-serviceworker` 在首次打开时刷新一次，为 ONNX Runtime Web 启用 WASM 多线程。

## 模型来源与许可

- FP32：[`Carve/LaMa-ONNX`](https://huggingface.co/Carve/LaMa-ONNX)，固定提交 `c3c0c9e468934d62e79c329e35d82dd09ff8c444`，Apache-2.0。
- INT8：[`g-ronimo/lama`](https://huggingface.co/g-ronimo/lama)，固定提交 `418036c6b541e526cdbb0bead1ec3a87dabede53`，Apache-2.0。
- 网页运行时：[`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web) 1.26.0，MIT。
- GitHub Pages 多线程兼容层：[`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker) 0.1.7，MIT。

各组件的说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
