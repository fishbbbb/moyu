# 网页导入样例严格自测报告

- 总站点数: 1
- 通过数: 0
- 未通过数: 1

## 性能概览（自测样本）

- totalMs: p50=6728ms, p90=6728ms, avg=6728ms
- chapterProbeMs: p50=293ms, p90=293ms, avg=293ms
- timeoutRate: 0
- domTooLargeRate: 0

| 站点 | basicInfo | toc | detailContent | chapterContent | content | navigation | paywall/auth | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tomato | Y | N | Y | Y | Y | N | N | FAIL |

## 失败清单

- tomato: 下一章跳转失败: NO_MAIN_CONTENT；目录提取失败（章节样本质量不足）；章节跳转验证失败
