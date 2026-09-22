# Xiaolin 去水印

面向 iPhone Safari 的免费批量去水印网页。图片、识别和 LaMa 推理都在浏览器本机完成，不需要账号、服务器或常开 Mac。

- 在线版：<https://kunlun7210.github.io/lama-watermark-web/>

本仓库是唯一正式版本：使用新版任务恢复与结果内存管理，同时保留同源模型分片和原 GitHub Pages 地址。

## 能做什么

- 一次选择并顺序处理 10–20 张，也支持继续追加；单个可恢复批次上限为 40 张或 220MB 原图。
- 识别 Gemini、豆包、即梦、千问、清言、元宝、文心和小红书水印；未识别时保持原图。
- Gemini 先尝试专用反向 Alpha 还原；质量检查不通过时自动改用 LaMa 局部修复。
- 主界面默认只显示 INT8 62MB；FP32 198MB 收在“模型信息”中，并注明手机端不推荐、无明显视觉提升。
- 每完成一张立即把结果写入 IndexedDB，并释放内存中的完整结果；预览、分享和 ZIP 需要时再读取。Safari 重载后会恢复原图、已完成结果和剩余任务。
- 超过 40 张或 220MB 的追加会在改动队列前整体拒绝，已有任务和结果保持不变；单张损坏也不会再清空其他可恢复图片。
- “未识别、保持原图”直接复用输入文件，不经过 canvas 重编码，下载和 ZIP 中的字节保持不变。
- iOS 用系统分享面板批量存入相册；也可生成包含全部结果的 ZIP。
- 首次下载的固定版本模型按分段缓存，之后可直接从本机缓存读取。
- 页面右上角显示语义版本和构建日期，用于确认 Safari 是否已经更新到最新部署。

Gemini 识别与专用还原使用内置的 48px / 96px Alpha 模板，解码后合计 11,520 bytes，不需要下载额外模型。

## 这版解决的问题

| 原问题 | 当前做法 |
| --- | --- |
| 模型下载受单一线路影响 | 仓库保留审核过的模型分片，以固定提交的 jsDelivr、Hugging Face 固定 revision 和同源 Pages 三路下载；完整拼装后校验 SHA-256。 |
| 模型误更新 | CI 同时核对审核版本、尺寸、SHA-256、分片清单和仓库中的实际二进制。 |
| Safari 重载只恢复原图 | 原图任务和每张完成结果分库存储，重载后可直接继续；整批完成后重开页面不会无意义地初始化模型。 |
| 边界错误破坏已有批次 | 超限追加在写库前原子拒绝；恢复时逐项读取结果，单个损坏或读取失败不会清空整批。 |
| 未识别 JPEG 被再次压缩 | 未识别项直接保存原始 File，文件字节、格式与元数据不再经过 canvas 改写。 |
| 旧 HTML 引用已删除入口 | JS/CSS 使用稳定文件名并带构建查询参数；迁移桥保留审计涉及的前两版旧入口，避免本次切换出现 404。 |
| 推理超时无法停止 | ONNX Runtime 放进独立 Web Worker；会话初始化或单张推理超过 120 秒都会终止 Worker。 |
| OOM 降线程当场不生效 | 只对明确的 WASM 内存分配错误执行 4 → 2 → 1 重建重试；降级仅影响当前页面，重新打开会恢复自动设置。 |
| 批量结果占用两份内存 | 落盘成功后只保留缩略图和元数据，完整 Blob 在预览、分享、打包时按需从 IndexedDB 读取。 |
| 私密浏览或隔离失效 | 内部自动按浏览器能力选择线程；普通界面不展示实现参数，排障信息保留在控制台。 |
| 开始前不知道要等多久 | 根据本机历史耗时给出整批预计时间，处理后持续校正。 |
| 单文件过大 | 推理控制、Worker、任务存储、规则、图像原语和 ZIP 已拆成独立模块。 |

## 模型和下载

| 模型 | 大小 | SHA-256 | 来源提交 |
| --- | ---: | --- | --- |
| INT8 | 62,074,990 bytes | `cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe` | `g-ronimo/lama@418036c6…` |
| FP32 | 208,044,816 bytes | `1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6` | `Carve/LaMa-ONNX@c3c0c9e4…` |

默认顺序为固定提交的 jsDelivr → 固定 revision 的 Hugging Face → 同源 Pages。jsDelivr 只做整段下载；另外两个源支持严格 `Range` 校验和段内续传。换源时从当前分段开头重下，完整拼装后再次校验 SHA-256。`?source=hf` 可优先 Hugging Face，`?source=origin` 可优先 Pages。

## 本地运行

```bash
npm install
npm test
npm run dev
```

真实浏览器回归脚本需要另行启动带 CDP 的 Chrome：

```bash
node scripts/browser-ui-check.mjs
node scripts/browser-boundary-check.mjs
node scripts/browser-stale-entry-check.mjs
node scripts/browser-batch-test.mjs /绝对路径/水印测试集
node scripts/browser-completed-restore-check.mjs
MODEL=fp32 node scripts/browser-single-test.mjs /绝对路径/一张测试图.png
node scripts/browser-gemini-parity.mjs /绝对路径/Gemini测试集 tests/gemini-parity-expected.json /绝对路径/非Gemini测试集
node scripts/browser-zip-check.mjs
```

## 验证

当前实测结果见 [VALIDATION.md](./VALIDATION.md)。历史基线和规则移植记录保留在 [docs/BASELINE-EVALUATION.md](./docs/BASELINE-EVALUATION.md)。

模型与第三方组件许可见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
