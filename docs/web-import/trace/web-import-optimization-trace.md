# 网页导入优化回溯记录（2026-04-16 更新）

## 1) 本轮目标

- 将“站点特例/通用提取”从单体逻辑重构为 `core + adapters` 可维护结构。
- 建立可重复执行的质量门禁（字段一致性、最小核心自测、全量样本回归）。
- 增加提取性能可观测性，支持按阶段定位慢点并进行回归对比。

## 2) 本轮主要改动

### 2.1 架构重构（保持行为不变）

- 类型抽离：`desktop/electron/web-import/types.ts`
- adapter 拆分：
  - `desktop/electron/web-import/adapters/index.ts`
  - `desktop/electron/web-import/adapters/{weread,tadu,bqudu,jjwxc,domain-cleaner}.ts`
- core 拆分：
  - `desktop/electron/web-import/core/navigation-resolver.ts`
  - `desktop/electron/web-import/core/toc-detector.ts`
  - `desktop/electron/web-import/core/content-extractor.ts`
- 门面保留：`desktop/electron/webContentExtractor.ts` 继续对外提供原接口，内部委托到 core/adapters。

### 2.2 质量与一致性门禁

- `desktop/scripts/selftest-web-import-samples.mjs`
  - 新增 PASS 一致性守卫，避免“状态通过但证据缺失”假阳性。
  - 修正导航口径，允许 `toc_adjacent_ok`、`expected_block` 等合法兜底场景。
- 新增核心最小自测：`desktop/scripts/selftest-web-import-core.mjs`
  - 覆盖 adapter 注册完整性
  - 覆盖 TOC 质量判定
  - 覆盖 next 降级策略（中置信度需用户确认）

### 2.3 性能可观测性

- 运行时阶段耗时日志：`desktop/electron/main.ts`
  - 标签：`[web-import][timing] extraction ok/failed`
  - 指标：`waitReadyMs/lazyLoadMs/extractPageMs/extractContentMs/detectNavigationMs/detectTocMs/resolveNextMs/totalMs`
- 自测报告性能分位：`../selftest/web-import-selftest-report.md`
  - `p50/p90/avg totalMs`
  - `p50/p90/avg chapterProbeMs`
  - `timeoutRate`、`domTooLargeRate`

## 3) 回归执行

- `npm run selftest:web-import-core`
- `npm run selftest:web-import`

输出：

- `../selftest/web-import-selftest-report.md`
- `../selftest/web-import-selftest-report.json`
- `../selftest/web-import-selftest-failure-trace.md`
- `../selftest/web-import-selftest-baseline-2026-04-16.md`

## 4) 当前结果摘要（严格口径）

- 样本总数：18
- 通过：13
- 失败：5
- 当前 FAIL 站点：`qidian`、`seventeenk`、`faloo`、`qd_girls`、`motie`

## 5) 已知边界与下一步

- 失败站点主要受反爬、付费/登录、动态渲染与站点结构噪声影响。
- 下一步优先按性能与失败原因双维度推进：
  - 先针对 `p90 totalMs` 高站点做等待/懒加载策略优化；
  - 再按 FAIL 站点逐个补通用规则或低频 adapter。

## 6) 本轮增量优化记录（持续回归：2026-04-16）

### 6.1 通用优化

- `desktop/electron/web-import/core/toc-detector.ts`
  - 增加“低质量 TOC 二次抢救”流程：当首轮 TOC 命中疑似导航噪声时，执行全局章节链接回收并重建候选。
  - 目标是优先修复“目录页抓到菜单而非章节列表”的通用问题，避免针对单域名硬编码。
- `desktop/electron/webContentExtractor.ts`
  - 针对短章节增加“字数提示感知”门槛：页面出现“本章字数：N字”时，自适应下调最小正文长度阈值。
  - 对短文本场景放宽字体混淆阈值，避免将可读短章误判为 `FONT_OBFUSCATED`。
- `desktop/electron/web-import/core/navigation-resolver.ts`
  - 为 TOC 相邻 next 增加“可疑链接过滤 + 同域优先”策略，减少跨域噪声 next 误命中，同时避免误伤非标准章节 URL。
- `desktop/scripts/selftest-web-import-samples.mjs`
  - 增强章节链接识别：支持 `/{bookId}_{seq}.html` 这类短序号章节 URL（例如 `_1.html`）。
  - 增强网络抓取容错：`fetch` 命中 `HTTP2 framing layer` 时，自动降级 `curl --http1.1`。
  - `chapter_sequence` 兜底在无章节名时用 URL 数值合成章节标题，提升动态站点 TOC 可判定性。
  - 输出与样本输入路径迁移到 `desktop/docs/web-import/selftest` 与 `desktop/docs/web-import/samples`，保持文档整理后一致。

### 6.2 风险控制与口径收敛

- 新增“付费壳页”识别函数（仅用于自测口径判定），确保预期拦截站点在 trace 中可解释。
- 对“章节摘录为空即判失败”的规则增加拦截豁免保护，避免误伤预期付费壳页。
- 所有改动均以“通用规则优先”实现，未引入按 host if/else 的主干分支。

### 6.3 本轮回归结果

- 执行：`npm run selftest:web-import-core` + 多轮 `npm run selftest:web-import`
- 当前结果：`18 = 13 PASS / 5 FAIL`
- 核心收益：
  - `tomato` 从 FAIL 提升为 PASS（`NO_MAIN_CONTENT` -> 可读短章 + 可用 next + chapter_sequence TOC）；
  - `free_biquge` 在导航策略调整后维持 PASS，无分页跳转回归；
  - 失败证据更稳定：`motie` 维持为可复现的网络/环境限制（HTTP2 framing + `NO_MAIN_CONTENT`）；
  - 网络兼容性增强：HTTP/2 framing 错误具备自动降级路径。
- 仍未突破的站点：`qidian`、`seventeenk`、`faloo`、`qd_girls`、`motie`
