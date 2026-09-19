# LaMa 浏览器版可行性记录

日期：2026-09-18

## 结论

核心算法可在纯浏览器中运行，图片无需上传，也无需推理服务器。浏览器版使用与桌面版同类的 LaMa 修复流程，真实样图输出明显优于纯 Canvas 的 CleanMark。FP32 与 INT8 两个模型已完成本地同图对比；当前唯一未完成的关键验证是 GitHub Pages 上 iPhone 15 Pro / iPhone 17 Safari 的真实耗时与峰值内存。

## 模型与运行时

- 模型：`Carve/LaMa-ONNX/lama_fp32.onnx`
- 固定提交：`c3c0c9e468934d62e79c329e35d82dd09ff8c444`
- 文件大小：208,044,816 bytes
- SHA-256：`1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6`
- 模型许可：Apache-2.0
- 运行时：`onnxruntime-web` 1.26.0，WASM 后端

第二个模型：

- 模型：`g-ronimo/lama/lama_512_int8.onnx`
- 固定提交：`418036c6b541e526cdbb0bead1ec3a87dabede53`
- 文件大小：62,074,990 bytes
- SHA-256：`cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe`
- 固定输入：单个 `[1,4,512,512]` 张量，前三通道为挖空 RGB，第四通道为二值遮罩
- 模型许可：Apache-2.0

## 真实测试集

测试目录：`~/Downloads/水印测试集/`

- 共 79 个文件。
- 精确规则找到并执行 LaMa：60 张。
- 规则未找到水印并保持原图：14 张。
- 5 个文件扩展名为 JPG、实际编码为 HEIC，当前 Python 测试解码器未处理。
- 已逐组查看豆包、元宝/文心、千问、智谱清言、即梦、小红书的接触表；总体质量接近现有桌面 TorchScript LaMa。
- INT8 与 FP32 的 60 张修复区域对比：平均 MAE 2.35/255，中位数 MAE 2.00/255，平均 PSNR 39.06dB；每张修复区域内任一通道差值超过 20 的像素平均占 0.61%。

## 性能

### Node + ONNX Runtime Web WASM

- 单线程推理：约 14.8 秒/张。
- 4 线程推理：约 4.7 秒/张。
- 一次完整运行后的 RSS：约 1.09GB。
- INT8 单线程推理：约 13.9 秒/张；4 线程推理：约 6.1 秒/张。
- INT8 的 WASM 四线程速度没有胜过 FP32；它保留的价值是模型仅 62.1MB，下载和内存压力较小。

### Chromium 浏览器

图片均为 1728×2304 PNG。

- 首张：模型准备 16.2 秒，推理 4.4 秒，总耗时 20.8 秒。
- 第二张复用模型：推理 4.4 秒，总耗时 4.6 秒。
- 4 个 WASM 线程，`crossOriginIsolated=true`。
- 控制台无错误或警告。

### 双模型 Chromium 回归

同一张 1728×2304 豆包 PNG，四线程、`crossOriginIsolated=true`：

- INT8：模型准备 0.6 秒，推理 3.4 秒，总耗时 4.4 秒。
- FP32：模型准备 4.4 秒，推理 4.5 秒，总耗时 9.1 秒。
- 两个结果画布均为 1728×2304，水印区域已修复。
- 页面切换模型时先释放现有 ONNX 会话，避免两个模型同时常驻内存。

## 已发现并修复的问题

1. 默认入口会让 Chromium 请求 JSEP 运行文件，现已改为 `onnxruntime-web/wasm` 并固定普通 WASM 文件。
2. 模型输出可能是 0–255；按 0–1 处理会产生白块。现按输出最大值判断数值范围。
3. 合成改为按原桌面引擎的 1.6px 羽化方式混合，避免硬边。
4. 模型下载改为按 `Content-Length` 预分配缓冲区，减少约 198MB 峰值内存。

## iPhone 15 Pro 首轮实测与修复

- iPhone 成功选择并解码 1728×2304 PNG，页面显示单线程、非隔离模式。
- 点击处理后没有进度；Vite 收到 iPhone 控制台错误 `TypeError: Load failed`。失败发生在从 Hugging Face 获取整块模型，尚未进入 ONNX 初始化或推理。
- Safari 切到后台后会重载页面，原先只保存在 JS 内存中的文件随之丢失。
- 修复：模型改为 13 个同源静态分段，每段最多 16MiB；下载时直接顺序写入 208,044,816-byte 预分配缓冲区。
- 修复：选图后将原始 `File` 保存到 IndexedDB；页面重载后自动恢复文件、预览、尺寸和处理按钮。
- Chromium 回归：强制重载后原图自动恢复；13 段模型下载、初始化和推理完成，总耗时 13.0 秒；控制台无错误或警告。

## iPhone 单线程瓶颈

- iPhone 已完成模型初始化并进入“LaMa 正在修复”，但局域网 HTTP 页面只能使用 1 个 WASM 线程；两三分钟仍未结束，实际体验不可接受。
- 这不是模型下载或水印规则问题，瓶颈是非安全上下文无法启用 WebAssembly 多线程。
- 临时 Cloudflare Quick Tunnel 保留了 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp` 响应头。
- HTTPS 页面已由浏览器确认：`线程=4`、`隔离模式=是`、`连接=HTTPS`。
- 临时测试地址仅用于验证 iPhone 多线程性能；正式版本应部署到支持同样响应头的免费 HTTPS 静态托管。

## iPhone 实机需要记录

- 页面能否完成约 198MB 模型下载和初始化。
- Safari 是否重载、白屏或提示页面占用过多内存。
- 首张推理耗时。
- 结果右下角是否完全去除且无明显接缝。
- 第二张是否复用模型并明显加快。

GitHub Pages 实机通过后再扩展：多文件选择、顺序队列、手动平台选择、精确规则、失败保持原图、ZIP 导出和断点恢复。

## 2026-09-19 多平台规则移植（iPhone 实机验证通过后）

iPhone 15 Pro / iPhone 17 上豆包水印验证通过，按要求把 Mac 版的其余规则直接搬到网页端。

### 移植范围与做法

- 新增 `src/imaging.js`：与 OpenCV 对应的小型原语（灰度、INTER_NEAREST / INTER_AREA 缩放、方框膨胀、高斯（ksize 按 OpenCV 的 `round(σ*8+1)|1`）、Sobel、Canny、HSV、TM_CCORR 相关、TM_CCOEFF_NORMED 形状相关）。
- 新增 `src/rules.js`：7 个平台检测器 + `detect()` 调度，顺序与去重规则照抄 `server.py`（即梦 → 元宝 → 文心 → 千问 → 清言 → 豆包 → 小红书，重叠 ≥60% 的后来者丢弃）。
- 新增 `src/maskData.js`：由 Mac 版源码**程序化导出**的位图模板常量（base64 + zlib + 1bit），避免手工转录出错。
- `public/templates/`：从 Mac 版复制的 `doubao_logo_mask.png`、`xiaohongshu_label.png`。
- `src/main.js`：改成「识别 → 逐区域推理 → 按掩膜羽化合成」；无匹配时保持原图并给出「未识别」状态。
- 逐区域修复沿用 512×512 模型：以区域为中心取方形窗口（含 context 边距），掩膜映射到窗口后在 512 分辨率上推理，再按掩膜（σ=1.6px 羽化）合成回原图。

### 基准与一致性结果

基准由 Mac 版自带的 Python 检测器在同一测试集（79 张）上生成（用 App 的 `.venv` 直接 import 各模块，不改动任何 App 文件）。

| 指标 | 结果 |
| --- | ---: |
| 完全一致（平台 + 矩形坐标误差 ≤2px） | 74 / 79 |
| 识别不一致 | 0 |
| 坐标偏差 | 0 |
| 两端都解码失败（`.JPG` 实为 HEIC） | 5 |

### 移植期间发现并修掉的三处偏差

1. **搜索窗口 stride 错位**：窗口助手对已经是不含上界的结束坐标又 `+1`，导致所有模板相关的行跨距比实际数组宽 1 像素 —— 表现为元宝对比度从 43.18 掉到 6.30。修正后各检测器数值与 Python 对齐（元宝 43.18 / 形状 0.808）。
2. **即梦区域被静默丢弃**：即梦的修复区域对象缺少 `found` 标记，被调度器的 `if (!region.found) return` 过滤掉，即梦 4 张全部漏检。补上标记后恢复为双区域修复。
3. **灰度未量化**：OpenCV 的 `cvtColor(..., COLOR_RGB2GRAY)` 输出 uint8，而 JS 侧保留了浮点；在阈值临界样本（文心 6964e26c，形状分 0.666 vs 0.650 阈值）会翻转判定。改为先 `Math.round` 再转 float32；同时把 `INTER_NEAREST` 改成 OpenCV 的 `floor(x*scale)`（原实现多了半像素偏移），模板前景像素数从 2413 回到 Python 的 2485。

### 浏览器端实跑

INT8、4 线程、本机 Chrome 152，7 个平台样例全部与 Python 判定一致（含「智谱无水印图 → 未识别保持原图」），单区域推理 3.3–3.4 s，即梦/文心+千问双区域约 6.5–6.6 s。

### 仍未做的部分

- Gemini 专用反向 Alpha 还原（需要 `.npy` Alpha 模板与增益搜索）未移植；测试集内也没有 Gemini 素材。
- `.JPG` 实为 HEIC 的文件在桌面 Chrome 无法解码；iOS Safari 走系统解码，需在 iPhone 上确认。当前失败提示只回显文件名。
- 批量选择、队列、ZIP 导出仍未实现。

