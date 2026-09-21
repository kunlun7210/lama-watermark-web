# 验证记录

本文件记录**已经实测过**的结论与依据。原则：只写跑过的数据，未验证的进最后一节明说。

日期：2026-09-21 ／ 版本：v0.16.0

## 一、自动检查（每次 push 与 `npm test` 都跑）

| 检查 | 内容 |
| --- | --- |
| `verify-models.mjs` | INT8 / FP32 模型字节数与 SHA-256 与清单一致 |
| `verify-gemini.mjs` | 48/96px Alpha 模板哈希、候选阈值边界、LaMa 回退门槛边界、纯色负样本 |
| `verify-thread-policy.mjs` | 线程上限取值 + **2 项源码约束**（不许再对旧键读写、必须清除旧键） |
| `verify-oom-retry.mjs` | 真 OOM 按 4→2→1 重试；`RangeError` / `no available backend` 必须快速失败 |
| `verify-inference-controller.mjs` | Worker 就绪、初始化失败、**初始化超时**、外部终止四条路径 |
| `verify-zip.mjs` | STORE 条目、UTF-8 文件名标志、载荷 CRC |
| `vite build` | 生产构建通过（bundle 约 135 kB） |

CI 分两层：

- **`Deploy GitHub Pages`** —— `npm test` + **浏览器 UI 断言（部署门禁）**，两者都在 `build` job 内、
  `deploy` 之前。断言失败则整个 job 失败，**Pages 不会更新**。
- **`Browser UI check (PR)`** —— 只在 PR 上跑同一套断言（不部署）。

浏览器断言跑在 `vite preview` 的**构建产物**上，不是 `npm run dev` 的源码 ——
tree-shaking、压缩、`import.meta.env` 替换、`?worker&inline` 这些只在构建后才成形。

## 二、规则一致性（与 Mac 版 Python 检测器对照）

79 张、6 平台测试集，逐张比较「识别平台 + 修复矩形坐标」：

| 结果 | 数量 |
| --- | ---: |
| 完全一致（坐标误差 ≤2px） | **74 / 79** |
| 识别不一致 | 0 |
| 坐标偏差 | 0 |
| 两端都解码失败（`.JPG` 实为 HEIC） | 5 |

Gemini 不在该基准内（Mac 版是另一套实现），单独验收；移植期间修掉的三处偏差见 [EVALUATION.md](./EVALUATION.md)。

## 三、Gemini 专项

- 24 张 Gemini 测试集：覆盖「反 Alpha 直接还原」与「质量不足退回 LaMa」两条分支。
- **干净样本回归**：4 张 `clean_*` 必须全部判为 `not-found`、像素不动。
  - 修复前 `clean_gemini_sample_2.png` 被判「已去除 · Gemini」并**真的擦了一块**（8.6 s）——
    相关性阈值只能说明"右下角像模板"，不能证明它是水印。
  - 加残差门槛（反 Alpha 后残差 > 0.35 即判 `not-found`）后，4 张全部「未识别 · 保持原图」，
    sample_2 从 8.6 s 误改变为 0.7 s 正确跳过。
- **真水印未被误杀**：走 LaMa 的样张 15.6 s、走反 Alpha 直还原的 3.2 s，两条分支均正常去除。
- 模板是内置位图数据（48px 2304 + 96px 9216 = **11,520 bytes**），不增加任何模型下载。

## 四、主线程阻塞量化（Worker 化 A/B）

20 张 Gemini，同机同批、模型已缓存；A 组为 `git worktree` 取出的改造前副本：

| 指标 | 主线程推理 | Worker 推理 |
| --- | ---: | ---: |
| 整批墙钟 | 161.6 s | **146.0 s** |
| 主线程长任务个数 | 37 | **20** |
| 长任务累计时长 | 157 s | **79 s** |
| 页内心跳平均间隔 | 1405 ms | **120 ms** |

- 心跳 = 页内 50 ms `setTimeout` 自触发，看**平均**间隔；长任务由 `PerformanceObserver` 读取。
- **单次最长长任务几乎没变**（5546 ms → 4685 ms）。用 CDP Profiler 归因（先 `vite build --minify false`
  保留函数名）：热点是 `ccorrMax`(35.3%) + `nccMax`(13.1%)，定义在 `imaging.js`、由 `rules.js` 调用，
  即水印定位的互相关搜索，占主线程约 48%，与推理无关。**要看平均与累计，不能被最大值带偏。**
- 复现：`node scripts/browser-ab-compare.mjs <改造前URL> <改造后URL> <样张...>`

## 五、浏览器端与线上实测

**真实 WebKit（Safari 内核）**——Chrome 模拟视口覆盖不到的部分：

| 项 | 托管站点 | GitHub Pages |
| --- | --- | --- |
| `crossOriginIsolated` | true（响应头直给） | true（coi-serviceworker 补） |
| `SharedArrayBuffer` | 可用 | 可用 |
| 内联 `Blob` Worker | ok | ok |
| 真实处理 | 通过 | 通过 |

**多平台（线上、真实 WebKit、INT8、4 线程）**：

| 平台 | 结果 | 总耗时 |
| --- | --- | ---: |
| 豆包 | 已去除 · 1 处 | 13.9 s |
| 即梦 | 已去除 · 2 处 | 11.6 s |
| 千问 | 已去除 · 1 处 | 4.2 s |
| 小红书 | 已去除 · 1 处 | 5.8 s |
| 元宝 / 文心 | 已去除 · 各 1 处 | 5.6 s / 4.9 s |
| Gemini | 已去除 · 1 处 | 8.6 s |
| 智谱清言 | 未识别 → 保持原图 | 0.5 s |

清言该样张判为「未识别」是**既有规则判定**：与移植前版本对同批样张做 A/B，结果与耗时一致
（0.6 / 0.7 / 0.6 s），非本次改动引入。

**批量**：20 张 Gemini 连续处理整批 146.0 s；27 张连续批量（含 4 张无法解码）无卡顿、无内存失败。

**恢复行为**（`browser-restore-check.mjs`，双向）：

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 整批都已完成 → 刷新恢复 | 不预热模型 | ✅ 只有 1 条基线日志 |
| 含未处理项 → 刷新恢复 | 照常预热 | ✅ 日志数 ≥ 2 |

## 六、发布核对

每次发布两个地址后固定做三项：

1. **产物等价**：两站独立构建，**剔除构建注入的时间戳与日期后**逐字节一致
   （v0.16.0：135,177 bytes，SHA-256 `e7f7759c…`）。
   ⚠️ 不能直接比 hash —— vite 会把构建时间戳注入 bundle，同一份源码构建两次字节数相同、hash 必然不同。
2. **线上 UI 断言**：14/14 通过、浏览器错误 `[]`。
3. **线上端到端**：真实上传 → 识别 → 推测 → 合成；并复跑干净样本，确认未被误改。

发布后另需注意：托管沙箱冷启动会重跑 `npm start`（含 `build`），因此**构建时间戳与界面日期会漂移**，
内容不变。**别把界面日期当发布凭据**，核版本请看 JS 里的 semver。

## 七、仍需实机确认（桌面浏览器无法替代）

- iPhone 15 Pro / iPhone 17 Safari 上 20 张批量处理的实际耗时、内存峰值与后台回收行为。
- 小内存机型（如 iPhone 13）多线程 OOM 的真实触发点，以及 4→2→1 降级的实际效果。
- iOS 原生 HEIC 解码路径（`accept` 已含 heic/heif，桌面 Chrome 无法验证）。
- 「存入相册」的系统分享面板交互，以及低电量模式下 Wake Lock 被拒后的长批次表现。

## 八、可复现的验证脚本

```bash
npm test                                            # 自动检查（含构建）

# 真实 WebKit：环境诊断 + 真实处理（需先 npx playwright install webkit）
node scripts/browser-webkit-check.mjs <url> [样张...]

# A/B 对照：两个 URL、各自独立浏览器实例，输出耗时与主线程读数
node scripts/browser-ab-compare.mjs <urlA> <urlB> <样张...>

# 刷新恢复的双向验证（至少 3 张样张）
node scripts/browser-restore-check.mjs <url> <样张1> <样张2> <样张3>

# UI/文案/布局断言（CDP，可指向线上地址）
node scripts/browser-ui-check.mjs
```

性能读数**只打印、不断言** —— 绝对值依赖机器与图片，硬断言会变成 flaky 测试。
