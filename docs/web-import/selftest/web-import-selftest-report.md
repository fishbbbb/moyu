# 网页导入样例严格自测报告

- 总站点数: 18
- 通过数: 13
- 未通过数: 5

## 性能概览（自测样本）

- totalMs: p50=2051ms, p90=7726ms, avg=3007ms
- chapterProbeMs: p50=62ms, p90=268ms, avg=91ms
- timeoutRate: 0
- domTooLargeRate: 0

| 站点 | basicInfo | toc | detailContent | chapterContent | content | navigation | paywall/auth | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qidian | N | N | N | Y | N | Y | Y | FAIL |
| jjwxc | Y | Y | Y | Y | Y | Y | Y | PASS |
| zongheng | Y | Y | Y | Y | Y | Y | Y | PASS |
| hongxiu | Y | Y | Y | Y | Y | Y | Y | PASS |
| xxsy | Y | Y | Y | Y | Y | Y | Y | PASS |
| yq | Y | Y | Y | Y | Y | Y | Y | PASS |
| seventeenk | N | N | N | N | N | Y | Y | FAIL |
| faloo | Y | N | Y | N | N | Y | Y | FAIL |
| shuqi | Y | Y | Y | Y | Y | Y | Y | PASS |
| zhangyue | Y | Y | Y | Y | Y | Y | Y | PASS |
| tomato | Y | Y | Y | Y | Y | Y | Y | PASS |
| qimao | Y | Y | Y | Y | Y | Y | Y | PASS |
| qd_girls | N | N | N | N | N | Y | Y | FAIL |
| readnovel | Y | Y | Y | Y | Y | Y | Y | PASS |
| qd_qqreader | Y | Y | Y | Y | Y | Y | Y | PASS |
| motie | N | N | N | N | N | N | N | FAIL |
| tadu | Y | Y | Y | Y | Y | Y | Y | PASS |
| free_biquge | Y | Y | Y | Y | Y | Y | Y | PASS |

## 失败清单

- qidian: 基本信息提取失败（标题/URL）；目录提取失败（章节样本质量不足）；简介页正文提取失败（长度不足或未识别）；正文提取失败（简介页与章节页未同时达标）
- seventeenk: 基本信息提取失败（标题/URL）；目录提取失败（章节样本质量不足）；简介页正文提取失败（长度不足或未识别）；章节页正文提取失败（长度不足或未识别）；正文提取失败（简介页与章节页未同时达标）
- faloo: 目录提取失败（章节样本质量不足）；章节页正文提取失败（长度不足或未识别）；正文提取失败（简介页与章节页未同时达标）
- qd_girls: 基本信息提取失败（标题/URL）；目录提取失败（章节样本质量不足）；简介页正文提取失败（长度不足或未识别）；章节页正文提取失败（长度不足或未识别）；正文提取失败（简介页与章节页未同时达标）
- motie: 目录页获取失败: Command failed: curl -k -L --max-time 18 -A Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 -H Accept-Language: zh-CN,zh;q=0.9,en;q=0.8 https://www.laikan.com/book/89491
  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
                                 Dload  Upload   Total   Spent    Left  Speed
  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0  0     0    0     0    0     0      0      0 --:--:--  0:00:08 --:--:--     0  0     0    0     0    0     0      0      0 --:--:--  0:00:08 --:--:--     0
curl: (16) Error in the HTTP2 framing layer
；章节页提取失败: NO_MAIN_CONTENT；下一章跳转失败: NO_MAIN_CONTENT；基本信息提取失败（标题/URL）；目录提取失败（章节样本质量不足）；简介页正文提取失败（长度不足或未识别）；章节页正文提取失败（长度不足或未识别）；正文提取失败（简介页与章节页未同时达标）；章节跳转验证失败
