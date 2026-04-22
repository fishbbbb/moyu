# web-import 自测基线快照（2026-04-16）

## 基线信息
- 生成时间（UTC）: `2026-04-16T07:28:07.716Z`
- 样本总数: `18`
- 通过数: `12`
- 失败数: `6`

## 对应产物
- 汇总报告: `./web-import-selftest-report.md`
- 机器可读结果: `./web-import-selftest-report.json`
- 逐链接追踪: `./web-import-selftest-failure-trace.md`

## 本次基线关键变化
- 已启用 PASS 一致性守卫，避免“检查项全绿但证据缺失”的假阳性。
- 修正了导航一致性口径：允许 `toc_adjacent_ok` 与 `expected_block` 等兜底场景无显式 next/prev 链接。
- 当前不存在 `一致性检查失败` 条目（见 `failure-trace`）。

## 当前 FAIL 站点
- `qidian`
- `seventeenk`
- `faloo`
- `tomato`
- `qd_girls`
- `motie`

## 后续比较建议
- Phase B/C 后每次回归至少对比:
  - FAIL 站点列表是否异常变更；
  - 每站点失败原因是否新增“未知类型”；
  - PASS 站点是否出现一致性告警回归。
