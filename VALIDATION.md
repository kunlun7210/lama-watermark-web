# 验证记录

本文件记录**已经实测过**的结论与依据。原则：只写跑过的数据，未验证的进最后一节明说。

日期：2026-09-21 ／ 版本：以 `package.json` 为准（本文件数据覆盖 v0.11.2 – v0.17.1）

## 一、自动检查（每次 push 与 `npm test` 都跑）

| 检查 | 内容 |
| --- | --- |
| `verify-models.mjs` | INT8 / FP32 模型字节数与 SHA-256 与清单一致 |
| `verify-gemini.mjs` | 48/96px Alpha 模板哈希、候选阈值边界、LaMa 回退门槛边界、纯色负样本 |
| `verify-thread-policy.mjs` | 线程上限取值 + **2 项源码约束**（不许再对旧键读写、必须清除旧键） |
| `verify-oom-retry.mjs` | 真 OOM 按 4→2→1 重试；`RangeError` / `no available backend` 必须快速失败 |
| `verify-inference-controller.mjs` | Worker 就绪、初始化失败、**初始化超时**、外部终止四条路径 |
| `verify-zip.mjs` | STORE 条目、UTF-8 文件名标志、载荷 CRC |
| `verify-batch-limits.mjs` | 批次上限纯函数：40 张/200MB 边界闭区间、超限原因与文案 |
| `vite build` | 生产构建通过（bundle 约 136 kB） |
| `verify-build-entry.mjs` | `dist/` 只引用固定入口 `assets/app.js` / `app.css` 且带 14 位构建参数；两个旧入口迁移文件就位 |

CI 分两层：

- **`Deploy GitHub Pages`** —— `npm test` + **三组浏览器断言（部署门禁）**，都在 `build` job 内、
  `upload-pages-artifact` 之前。断言失败则整个 job 失败，**Pages 不会更新**：
  1. `browser-ui-check.mjs` —— UI/文案/布局
  2. `browser-boundary-check.mjs` —— 原图字节一致 / 超限追加原子拒绝 / 损坏首图不拖垮整批
  3. `browser-stale-entry-check.mjs` —— 旧入口迁移桥能到达新版且不循环刷新
- **`Browser UI check (PR)`** —— 只在 PR 上跑同一套三组断言（不部署）。

浏览器断言跑在 `vite preview` 的**构建产物**上，不是 `npm run dev` 的源码 ——
tree-shaking、压缩、`import.meta.env` 替换、`?worker&inline` 这些只在构建后才成形。

### 入口固定与旧入口迁移桥（v0.17.1 起）

入口 JS 救不了「入口 JS 已经 404」：旧版入口带内容哈希，新部署会删掉旧哈希文件，
于是拿着缓存 HTML 的用户白屏，连版本检查都跑不起来。现在：

- 构建入口固定为 `assets/app.js` / `assets/app.css`，新旧内容靠 `?v=<14 位构建版本>` 区分；
- 版本不一致时不再 `location.reload()`，而是加 `app-build=<版本>` 后 `location.replace()` 换文档 URL；
- `public/assets/index-DiAJy31j.js`（迁移桥）与 `index-BlVSS6-9.css`（线上真实字节）
  为一个过渡期的跳板。⚠️ **至少保留数个版本再删** —— 总有用户拿着很久以前的缓存页面回来。

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

**测量方法**——每条都是踩过坑才补上的，缺一条结论就站不住：

- **对照版本必须只差被测的那一个变量**。先用 `git diff --stat v0.11.2 v0.12.0` 确认
  `rules.js / imaging.js / maskData.js / zip.js / gemini.js` 全部未改动、`main.js` 中
  识别/存储/模型加载相关改动为 0。
  ⚠️ 曾误用 v0.16.1 当对照（中间隔了四个版本），结论完全反过来。
- **两侧同时打开、逐轮交替测量**，不能"跑完 A 再跑 B"。实测同一个版本（v0.11.2）在两次
  顺序测量里分别得到 **7554 ms 与 12184 ms（差 61%）** —— 顺序测量时整侧共用一个时间窗口，
  系统负载与热节流的漂移会全部算到某一侧头上。
- 两侧各先跑一轮**预热并丢弃**，让模型下载与初始化落在计数之外。
- 用**生产构建**；`--minify false` / sourcemap 只用于第二轮函数归因。
- 心跳报 **avg / p50 / p95 / p99 / max**：只报平均会掩盖长尾，只报 max 又会被一次性长任务带偏。

结果（豆包样张 1 张 × 5 轮交替，本机 Chrome，两侧均生产构建）：

| 指标 | v0.11.2 主线程推理 | v0.12.0 Worker 推理 |
| --- | ---: | ---: |
| 单张耗时 avg | 7839 ms | 7804 ms |
| 整批墙钟 avg | 7.8 s | 7.8 s |
| 吞吐量 | 7.7 张/分钟 | 7.7 张/分钟 |
| 心跳 avg | 1008 ms | **85 ms** |
| 心跳 p50 | 52 ms | 51 ms |
| 心跳 **p95** | **5513 ms** | **52 ms** |
| 心跳 p99 | 7422 ms | 1341 ms |
| 长任务累计/轮 | 7491 ms | **3121 ms** |
| 长任务最长 | 5308 ms | 3115 ms |

**结论：Worker 化的收益完全在「响应性」，不在「吞吐量」。**

- 吞吐量两侧一致（7.8 s、7.7 张/分钟）—— 推理总工作量没变，本来就不该变。
- 主线程阻塞大幅下降：心跳 p95 从 5513 ms 降到 52 ms，长任务累计减半。
- **p50 两侧都是 51–52 ms**：说明"不卡的时候两边一样快"，差异全在长尾 ——
  这正是必须看分位数、不能只看平均的原因。

⚠️ 早先一次测量（20 张 Gemini、顺序测量）曾得出"整批 161.6 s → 146.0 s"，
把它读成吞吐量提升 **不可靠**：那次没有交替测量，9.7% 的差异很可能来自漂移。以本节表格为准。

另有一个与推理无关的固定热点：`ccorrMax`(35.3%) + `nccMax`(13.1%)，定义在 `imaging.js`、
由 `rules.js` 调用，占主线程约 48% —— 那是水印定位的互相关搜索，要提速得单独做降采样或预计算。

复现：`node scripts/browser-ab-compare.mjs <改造前URL> <改造后URL> <样张...> --repeat=5`

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

### v0.17.1：四项行为修复的验收（全部跑在 `vite preview` 的构建产物上）

| 项 | 判据 | 实测 |
| --- | --- | --- |
| 保持原图 = 原始字节 | 128×128 无水印 JPEG 经处理后，IndexedDB 结果与输入的**长度 + SHA-256** 完全一致；ZIP「原图」条目逐字节一致、CRC 通过 | ✅ 2381 字节 / sha256 一致 |
| 超限追加原子拒绝 | 已有 1 张结果时追加 40 张 → 指定文案、队列不变、`images`/`results` 不变、输入框清空、无模型请求 | ✅ 全部符合 |
| 损坏首图逐项隔离 | 损坏 JPEG + 有效 JPEG → 1 失败 + 1 有效；刷新后队列 2 张、结果 1 条、可预览/下载/进 ZIP，且不出现「浏览器清理」之说 | ✅ 全部符合 |
| 旧入口迁移桥 | 用旧迁移入口的 HTML 打开 → 最终 URL 带 `app-build=<14位>`、显示当前 semver、状态「等待选择图片」、资源顺序为桥 → `app.js?v=…`、0 异常 | ✅ 10/10 |

20 张真实混合样张回归（`browser-batch-regression.mjs`，中途强制刷新）：

| 阶段 | 实测 |
| --- | --- |
| 完成 2 张后强制刷新 | 恢复 20 张任务 + 2 个结果（待处理 18，与结果数自洽） |
| 继续处理剩余 | 已处理 16 · 未识别 4 · **失败 0** |
| 整批完成后再刷新 | 20/20 全部还原，无条目被打回待处理 |
| 已完成批次 | 未重建推理会话（仅 1 条基线日志）、未下载任何模型分片 |
| ZIP | 20 项、73.7 MB、CRC 全部通过；4 个「原图」条目与输入逐字节一致 |

回归的 4 张「未识别」里含 `IMG_7830/7831.WEBP`（清言既有判定）与两张 `clean_gemini_*` 干净样本 ——
前者顺带验证了「原图后缀保持 `.webp`，不会被改写成 `.png`」。

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

# 边界行为（字节一致性 / 超限原子拒绝 / 损坏首图隔离）；只跑构建产物
TEST_URL_PREFIX=http://127.0.0.1:4173 node scripts/browser-boundary-check.mjs

# 旧入口迁移桥：缓存里的旧 HTML 是否仍能到达新版
TEST_URL_PREFIX=http://127.0.0.1:4173 node scripts/browser-stale-entry-check.mjs

# 20 张真实图片回归（中途强制刷新 + ZIP 逐字节比对；需本机测试集，不进 CI）
TEST_URL_PREFIX=http://127.0.0.1:4173 \
  node scripts/browser-batch-regression.mjs "/Users/kunlun/Downloads/水印测试集" 20
```

性能读数**只打印、不断言** —— 绝对值依赖机器与图片，硬断言会变成 flaky 测试。
