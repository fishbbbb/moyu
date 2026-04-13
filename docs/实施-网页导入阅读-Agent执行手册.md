# 实施手册：网页导入阅读（供后续 Agent 执行）

> 目的：让任何后续 Agent 在不依赖口头补充的情况下，按统一标准完成“网页导入阅读”功能开发。

## 1. 背景与目标

本项目要实现“书籍级网页导入”，而不是仅做单页正文提取。

### 1.1 核心目标（必须全部满足）

1. 用户输入 **简介页 URL** 或 **章节页 URL**，都能归并为同一本书（统一 `bookId/workId`）。
2. 导入后可获得可用的章节目录（TOC），并用于阅读导航。
3. 点击目录任意章节可正确跳转。
4. 阅读器内“上一章/下一章”按目录顺序正确跳转。

### 1.2 成功定义

- 双入口（简介页/章节页）可导入同一本书。
- 至少在首章/中间章/末章验证 prev/next 行为正确。
- 跳转逻辑以本地章节索引为真值，不依赖网页按钮。

---

## 2. 非目标（本期不做）

1. 不做“覆盖所有网站”的一次性适配。
2. 不绕过登录态/付费墙/验证码。
3. 不实现大规模分布式抓取。
4. 不实现自动化规则可视化编辑器（放到后续版本）。

---

## 3. 架构原则（必须遵守）

### 3.1 三层策略

1. **通用主链路**：Readability + 通用 TOC/next/prev 识别。
2. **站点规则补丁**：仅针对高频失败站点加适配。
3. **人工兜底**：低置信度时允许用户确认/选择。

### 3.2 单一真值源

- 阅读器跳章必须基于本地 `chapters[index]`。
- 页面内 `a[rel=next|prev]` 仅用于抓取线索，不作为最终跳转真值。

### 3.3 可观测性优先

- 每次提取必须产出策略来源、置信度、失败原因。
- 失败必须返回标准错误码，不允许“静默失败”。

---

## 4. 数据模型规范（MVP）

## 4.1 Book

- `bookId: string`
- `canonicalUrl: string`
- `title: string`
- `site: string`
- `sourceType: 'intro' | 'chapter' | 'unknown'`

## 4.2 Chapter

- `chapterId: string`
- `bookId: string`
- `index: number`（0-based，唯一且连续）
- `title: string`
- `url: string`
- `prevChapterId?: string`
- `nextChapterId?: string`

## 4.3 ExtractionMeta

- `strategy: string`（如 readability / toc-nav / site-adapter）
- `confidence: number`（0~1）
- `errors: string[]`
- `warnings: string[]`

---

## 5. 导入状态机（实现顺序）

1. `URL_INPUT`
2. `URL_NORMALIZE`
3. `ENTRY_CLASSIFY`
4. `BOOK_ID_RESOLVE`
5. `TOC_RESOLVE`
6. `CHAPTER_EXTRACT`
7. `LINK_GRAPH_BUILD`
8. `VALIDATE`
9. `IMPORT`

### 5.1 状态约束

- 任一步骤失败必须返回错误码并结束流程。
- `VALIDATE` 未通过时不写入正式书架数据。

---

## 6. 识别与提取规则

## 6.1 URL 归一化

- 统一协议与主域名。
- 去除追踪参数（如 `utm_*`）。
- 处理尾斜杠与无意义 hash。
- 保留业务关键参数（若用于章节定位）。

## 6.2 入口分类（intro/chapter）

按以下信号加权判断：
- URL 路径语义（book/detail/novel vs chapter/read/content）
- DOM 结构（目录区、章节标题、正文容器）
- 元数据（JSON-LD/meta）

## 6.3 TOC 识别优先级

1. 显式目录容器（`nav/ul/ol` + 目录语义词）
2. 批量章节链接区域
3. `link/a[rel=next|prev]`
4. 锚文本词典（上一章/下一章/previous/next）
5. URL 数字模式推断
6. 站点专用规则
7. 人工确认

## 6.4 章节顺序与邻接

- `index` 由 TOC 顺序决定，不由标题文本排序。
- `prev/next` 由 `index` 推导。
- 若索引不连续，判定 `TOC_PARTIAL`。

---

## 7. 错误码标准（必须返回）

- `ENTRY_UNSUPPORTED`
- `BOOK_ID_UNRESOLVED`
- `TOC_NOT_FOUND`
- `TOC_PARTIAL`
- `CHAPTER_PARSE_FAILED`
- `NEXT_PREV_LOW_CONFIDENCE`
- `AUTH_REQUIRED`
- `PAYWALL_BLOCKED`
- `RATE_LIMITED`

---

## 8. 实施任务清单（给 Agent 的执行顺序）

## Task A：类型与错误码基建

- 在 `src/content-extractor/types.ts` 增加/校准 Book、Chapter、ExtractionMeta。
- 在 `errorHandler.ts` 增加标准错误码与错误映射。

**完成标准**：类型可编译，错误码可在日志与返回结果中稳定出现。

## Task B：入口归一

- 在 `bookNormalizer.ts` 实现 URL 归一与 `bookId` 归并。
- 支持简介页与章节页归并到同一 `bookId`。

**完成标准**：同一本书不同入口导入后 `bookId` 一致。

## Task C：目录与章节图构建

- 在 `chapterDetector.ts` 按优先级实现 TOC 检测。
- 输出稳定的 `chapters[index]` 序列并生成邻接关系。

**完成标准**：目录点击可定位到对应 index 章节。

## Task D：阅读器跳转接入

- 阅读器页面改为基于本地目录索引跳转。
- 首章 prev 禁用；末章 next 禁用。

**完成标准**：首/中/末三段跳转行为正确。

## Task E：验证与回归

- 增加 smoke case（简介入口、章节入口、双向归并）。
- 输出每次导入的 `strategy/confidence/errors/warnings`。

**完成标准**：核心用例通过，失败可归因。

---

## 9. 测试与验收

## 9.1 必测用例

1. 简介入口导入 -> 目录可见 -> 任意章节跳转正确
2. 第一章入口导入 -> 归并同书 -> 目录完整
3. 首章 prev、中间章 prev/next、末章 next 行为正确
4. 刷新后恢复阅读位置并继续正确跳转

## 9.2 建议指标（V1）

- TOC 完整率（目标站点）≥ 95%
- 跳转正确率 ≥ 99%
- 错误码可归因率 ≥ 95%

---

## 10. 输出规范（Agent 每次提交必须包含）

1. **变更文件列表**（路径 + 作用）
2. **实现了哪些 Task（A~E）**
3. **测试结果**（通过/失败 + 原因）
4. **已知风险与后续建议**

---

## 11. 当前建议版本规划

- **V1**：通用链路 + 可插拔规则框架 + 1~3 个重点站点验证
- **V1.1**：基于错误码数据补 Top 失败站点适配
- **V2**：规则调试工具与批量导入优化

---

## 12. 执行备注

- 任何“无法稳定识别目录”的场景，优先保证“单章可读 + 明确提示”。
- 不允许因为低置信度推断导致错误跳转到评论页/推荐页。
- 若出现准确性与覆盖率冲突，优先准确性。
