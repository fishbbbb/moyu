# 网页导入测试清单（由 YAML 生成）

数据源：`../samples/websites-cn-novel-import-samples.yaml`

## A. 可直接回归站（免费/静态优先）

- `qidian` 起点中文网（`full`）
- `zongheng` 纵横中文网（`full`）
- `hongxiu` 红袖读书（`full`）
- `xxsy` 潇湘书院（`full`）
- `yq` 云起书院（`full`）
- `readnovel` 小说阅读网（`full`）
- `tadu` 塔读文学（`full`）
- `free_biquge` 笔趣阁（`full`）

## B. 动态渲染站

- `shuqi` 书旗小说（`dynamicRendering: true`）
- `tomato` 番茄小说（`dynamicRendering: true`）
- `qimao` 七猫小说（`dynamicRendering: true`）
- `qd_qqreader` QQ 阅读（`dynamicRendering: true`）

## C. 登录/付费高风险站

- `jjwxc` 晋江文学城（`requiresLoginOrPaywall: true`）
- `qd_qqreader` QQ 阅读（`requiresLoginOrPaywall: true`）
- `seventeenk` 17K（目录/章节状态 `chapter_only`，含登录/付费风险）
- `faloo` 飞卢（分页与付费风险）
- `zhangyue` 掌阅（样例备注含登录/订阅风险）
- `motie` 磨铁（`detail_only`，章节直链待补）
- `qd_girls` 起点女生网（`chapter_only`）

## D. 对照组（不纳入真实覆盖统计）

- `misc_blog` 通用博客/专栏文章（虚拟样例）

## 回归判定字段（逐链接）

- `basicInfo`: 标题/URL/域名提取是否有效
- `toc`: 目录识别状态（`ready/partial/missing`）
- `content`: 正文是否达到最小可读长度
- `navigation`: 下一章/上一章是否命中
- `paywallOrAuth`: 付费/登录提示是否命中预期错误码
