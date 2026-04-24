# web-import 重构续做计划（可执行跟踪版）

## 1) 当前重构进度（基于现有代码核对）

### 已完成（可确认）
- 已落地“通用主干 + 站点增强”架构雏形：`SiteAdapter`、`createSiteAdapters()`、`findSiteAdapters()` 已在 `webContentExtractor.ts` 中存在并被主流程调用。
- 站点增强钩子已接入：`preExtract`、`postProcessText`、`detectTOC`、`ignorePagination`、`shouldIgnoreMetaDescription`、`hasInjectedChapterBody`。
- `main.ts` 调用链已切到结构化接口：`extractCurrentPageAsync` + `detectTOC` + `resolveNextChapter`。
- 已有若干站点 adapter（如 `weread`、`tadu`、`jjwxc`、`bqudu`、`readnovel`）并在统一机制下运行。
- 已增加提取分段耗时埋点（`runStructuredExtraction`）：
  - 成功日志：`[web-import][timing] extraction ok`
  - 失败日志：`[web-import][timing] extraction failed`
  - 指标：`waitReadyMs`、`lazyLoadMs`、`extractPageMs`、`extractContentMs`、`detectNavigationMs`、`detectTocMs`、`resolveNextMs`、`totalMs`
- 已完成 adapter 目录首轮拆分（零行为回归）：
  - 新增 `web-import/adapters/index.ts`
  - 新增 `web-import/adapters/weread.ts`
  - 新增 `web-import/adapters/tadu.ts`
  - 新增 `web-import/adapters/bqudu.ts`
  - 新增 `web-import/adapters/jjwxc.ts`
  - 新增 `web-import/adapters/domain-cleaner.ts`
  - `webContentExtractor.ts` 改为通过 adapter factory 注入注册
- 已开始 Phase C 通用主干迁移（零行为回归）：
  - 新增 `web-import/core/navigation-resolver.ts`
  - 已迁移 `collectNavNextCandidates` / `resolveNextChapter` 决策逻辑到 core 模块
  - 新增 `web-import/core/toc-detector.ts`
  - 新增 `web-import/core/content-extractor.ts`
  - 已迁移 `detectTOC`、`extractStructuredData`、`fallbackExtract` 到 core 模块

### 未完成（核心堵点）
- `webContentExtractor.ts` 仍是单体大文件（约 1773 行），adapter 逻辑与通用提取主干仍然耦合在同一文件内。
- 站点能力没有拆分为模块目录，后续新增/回归难度高，修改风险大。
- 自测报告与追踪证据层面仍有一致性风险（PASS 站点的字段口径偶发不一致）。
- 尚缺“行为不变前提下”的结构迁移验收基线（迁移前后 diff 验证与自测门禁）。

## 2) 本轮重构目标（续做范围）

目标不是“再加特例”，而是把已实现的能力整理成可维护结构：
- 保持现有行为与线上表现不回退；
- 将 `webContentExtractor.ts` 拆为 `core + adapters/*`；
- 建立最小回归门禁，优先保证目录检测、正文提取、下一章跳转三条链路稳定。

## 3) 分阶段执行计划

## Phase A：冻结行为基线（先保守）
- [x] 固化当前样本集与自测输出（以当前 `../selftest/web-import-selftest-report.md`/`../selftest/web-import-selftest-failure-trace.md` 为对照基线）。
- [x] 补一个“关键字段一致性检查”脚本规则：
  - `PASS` 时必须满足的字段条件（如 `basicInfo`、`toc`、`navigation` 与正文长度口径一致）；
  - 允许 `paywall/auth` 预期拦截但需显式标注原因。
- [x] 输出迁移前基线快照（用于后续逐阶段比对，见 `web-import-selftest-baseline-2026-04-16.md`）。
- [x] 加入运行时性能可观测性（分段耗时日志），用于后续针对性优化。

验收标准：
- 在不改提取逻辑前提下，重复跑自测结果波动可解释；
- 可明确识别“预期拦截”和“真实失败”。
- 可从日志快速定位主要耗时阶段（加载/懒加载/页面抓取/正文提取/TOC/next）。

## Phase B：目录级拆分（不改行为）
- [x] 新建类型目录与文件：`desktop/electron/web-import/types.ts`（已完成，零行为改动）。
- [x] 新建目录建议：
  - `desktop/electron/web-import/core/`
  - `desktop/electron/web-import/adapters/`
- [x] 先抽类型与协议（零行为改动）：
  - [x] 已迁移公共类型：`ExtractResult`、`NavigationResult`、`TocResult`、`ExtractErrorCode` 等至 `types.ts`。
  - [x] 已迁移内部类型：`SiteAdapter`、`SitePreExtractContext`、`SitePreExtractResult`。
- [x] 把 adapter 注册与站点清单迁出：
  - [x] `createSiteAdapters` 已迁到 `adapters/index.ts`；
  - [x] 已拆站点：`weread.ts`、`tadu.ts`、`jjwxc.ts`、`bqudu.ts`；
  - [x] 站点域名清洗规则已抽象到 `domain-cleaner.ts`。

验收标准：
- 编译通过；
- 自测结果与 Phase A 基线一致或仅有可解释微差。

## Phase C：通用主干拆分（逐函数迁移）
- 将通用算法迁到 `core`：
  - 正文候选提取与清洗；
  - TOC 通用检测；
  - 下一章解析与置信度策略。
- `webContentExtractor.ts` 保留为 facade（门面）或过渡层，对外 API 不变。
- 每迁移一组函数就跑一次自测，避免一次性大迁移导致难定位回归。
- 当前进度：
  - [x] 下一章解析与候选聚合（`resolveNextChapter` / `collectNavNextCandidates`）已迁移到 `core/navigation-resolver.ts`
  - [x] TOC 通用检测迁移到 `core/toc-detector.ts`
  - [x] 正文候选提取主干（`extractStructuredData` / `fallbackExtract`）迁移到 `core/content-extractor.ts`

验收标准：
- 公开接口签名不变；
- 自测通过率不低于迁移前；
- 失败站点失败原因不出现“新增未知类型”。

## Phase D：一致性与可观测性收口
- 对 `PASS` 站点加字段一致性守卫，避免“状态 PASS 但正文字段空”的假阳性。
- 标准化 `章节标题来源` 与 TOC 命中优先级，减少 `extractor/html_title/toc_match` 漂移。
- 补最小单测/快照：
  - 站点 adapter 注册完整性；
  - TOC 条目质量判定；
  - next 解析降级逻辑。
- 增加性能门禁与回归口径（按 host 聚合）：
  - `p50/p90 totalMs`；
  - `extractContentMs` 占比；
  - 超时率与 `DOM_TOO_LARGE` 命中率。
- 当前进度：
  - [x] PASS 一致性守卫已接入自测并生效；
  - [x] 导航口径已统一（支持 `toc_adjacent_ok` / `expected_block` 场景）；
  - [x] 自测报告已输出性能分位口径（`p50/p90 totalMs`、`chapterProbeMs`、超时率、`DOM_TOO_LARGE` 命中率）；
  - [x] 最小单测/快照脚本已补：`selftest:web-import-core`（adapter 注册完整性 / TOC 质量 / next 降级）。

验收标准：
- 自测报告中的状态字段与证据字段一致；
- `failure-trace` 可直接用于问题复现和回归比较。

## 4) 执行顺序建议（下一次会话直接照做）
1. 先做 Phase A（半天内可完成，风险最低）。  
2. 进入 Phase B，先拆 `types + adapters/index`，再逐站点迁移。  
3. Phase C 只做“搬家不改逻辑”，每次迁移后立即自测。  
4. 最后 Phase D 做口径收口与最小测试补齐。  

## 5) 性能优化路线（基于现有埋点）
- 第一步：先跑一轮样本，按 host 导出耗时分布，标记 top 慢站点。
- 第二步：按“最慢阶段”定向优化：
  - `waitReadyMs` 高：减少不必要的 ready 等待或缩短等待上限；
  - `lazyLoadMs` 高：把 `triggerLazyLoad(7)` 改为按页面高度/增量内容提前停止；
  - `extractPageMs` 高：控制页面快照体积（保留关键 DOM 而非整页）；
  - `extractContentMs` 高：减少重复 DOM 构建与重复清洗链。
- 第三步：灰度验证，要求“性能改进不降低提取质量（PASS 率与证据一致性不回退）”。

## 6) 风险提示
- 最大风险是“结构迁移夹带行为修改”，会导致回归难以定位；必须严格分离。
- 目录与正文判定高度依赖页面噪声，任何清洗策略变更都需要样本回放验证。
- 对反爬/付费站点应保持“预期拦截可解释”策略，不要误判为提取器失败。
- 仅以单次耗时做判断可能误导，需要看分位数与失败率而不是平均值。

## 7) 完成定义（Definition of Done）
- `webContentExtractor.ts` 不再承载站点特例实现细节（仅保留门面/编排）；
- 站点规则位于 `adapters/*`，通用能力位于 `core/*`；
- 自测报告可稳定复现，且 PASS/FAIL 与证据字段一致；
- 新增站点时只需新增 adapter 文件并注册，不改通用主干；
- 样本集性能分位数稳定，且无明显性能回退（至少关注 `totalMs` 与 `extractContentMs`）。

## 8) 最新回归状态（2026-04-16，持续优化轮次）

- 已执行：`npm run selftest:web-import-core`、`npm run selftest:web-import`（多轮）。
- 当前覆盖：`14 PASS / 4 FAIL`（较基线提升 2 个站点）。
- 本轮完成的“通用优先”增量：
  - TOC 低质量二次回收机制（不依赖单站点硬编码）；
  - 样本自测章节 URL 识别扩展（支持短序号 `bookId_seq`）；
  - 抓取容错增强（HTTP/2 framing 失败降级到 curl HTTP/1.1）；
  - 短章节自适应阈值（根据“本章字数”放宽正文最小长度）；
  - TOC 相邻 next 的可疑链接过滤与同域优先策略；
  - `chapter_sequence` 在缺失章节名时按 URL 数值生成兜底章节名。
- 当前阻塞主要集中在：
  - 反爬/壳页站点（`qidian`、`seventeenk`、`qd_girls`）；
  - 环境/网络不稳定站点（`motie`）；
  - 目录噪声与付费壳页混杂站点（`faloo`，本轮已解决）。
