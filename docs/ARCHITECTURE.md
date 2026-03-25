# Architecture

本文件描述 `desktop/` 工程中 Electron 主进程、渲染进程（Vite/React）以及 Overlay（阅读条）之间的数据流与关键设计点。

## 进程与窗口

- **Main Window**：书架/导入/目录与控制（路由 `/#/`）
- **Overlay Window**：阅读条本体（路由 `/#/overlay`）
- **Overlay Toolbar Window**：阅读条工具栏（路由 `/#/overlay-toolbar`）
- **Overlay Settings Window**：阅读条设置窗（路由 `/#/overlay-settings`）

后三者都使用 `frame: false`，其中工具栏设置窗为独立窗口以避免被 overlay 窗口边界裁剪，并降低 Overlay 本体的复杂度。

## 数据存储

- SQLite：`better-sqlite3`
- 位置：`app.getPath('userData')/app.db`
- 主要表：
  - `books`：书籍
  - `items`：章节/分段（包含全文内容）
  - `progress`：阅读进度（以 `lineIndex` 表示）
  - `settings`：预留

## Overlay Session（阅读会话）

主进程持有 `OverlaySession` 并通过 IPC 广播给 overlay/工具栏/设置窗：

- `bookId`
- `itemId`
- `lines`：**原始行（不预切割）**，由 Overlay 端按窗口宽度/字号实时换行
- `lineIndex`
- `playing`

> 关键点：`lines` 不做预切割，避免窗口大小/字号变化后分页错乱。

## 渲染与排版

`OverlayView` 会根据当前窗口 bounds + 字号测量得到 `effectiveCols`，将 `rawLines` 动态切分为渲染 `lines`，并按 `rows` 组合出 `visibleText`。

### 缩放适配

缩放时通过 `overlaySetBounds` 更新窗口像素尺寸，同时反算更新 `rows/cols`，使“每页可显示行列”与当前窗口尺寸保持一致。

## 交互与拖动

### 为什么不用全正文 WebKit drag

全正文 `-webkit-app-region: drag` 会吞掉鼠标事件，影响点击、右键、遮罩、resize 等交互，因此只保留顶部极小 drag strip。

### 全正文拖动窗口如何实现

由渲染进程识别“拖动手势”（pointerdown/move 超过阈值）后通知主进程开始移动：

- 主进程用 `screen.getCursorScreenPoint()` 获取全局鼠标位置
- 定时更新 `overlayWindow.setBounds({x,y}, false)`（关闭动画保证跟手）

优势：鼠标离开窗口也不会丢事件，体验稳定。

## 透明窗口残影

透明 overlay 在部分平台/显卡组合下会出现残影。

当前策略：

- 自动阅读翻页时：先清空一帧再绘制
- `requestAnimationFrame` 补帧触发重绘
- 若仍存在，可考虑：
  - 极弱背景（alpha 极小）
  - 禁用硬件加速（副作用：性能/功耗）

