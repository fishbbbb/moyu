# 墨鱼阅读器（Desktop）

一个基于 **Electron + Vite + React** 的桌面阅读器，支持导入本地 txt 到书架，并以“桌面阅读条（Overlay）”的形式置顶阅读。

## 功能概览

- **导入 txt → 自动拆章（尽量识别“第 X 章/卷/Chapter”）→ 书架/目录**
- **桌面阅读条（Overlay）**
  - 置顶、透明背景
  - 点击正文显示工具栏
  - 拖动正文可移动窗口（frame=false 自定义拖动）
  - 拖动边框/角可缩放，缩放时按当前字号与窗口尺寸自适配行/列
  - 自动阅读（按字/分钟换算速度）
- **工具栏**
  - 开始/暂停、上一页/下一页、上一章/下一章、字号调整、设置、关闭
  - **按钮可在设置窗中配置增减（默认全选）**
- **快捷键**
  - 老板键：`Ctrl` + `Shift` + `X`（macOS 为 `⌘` + `Shift` + `X`）显示/隐藏阅读条

## 环境要求

- Node.js（建议 18+ 或 20+）
- npm
- macOS / Windows / Linux（透明窗口与合成器表现会因平台而异）

## 安装与启动

在 `desktop/` 目录执行：

```bash
npm install
```

开发模式（前端热更新 + Electron 启动）：

```bash
npm run dev
```

构建生产包（Vite build + ts 编译）：

```bash
npm run build
```

> 说明：本项目在 `postinstall` 里会执行 `electron` 下载与 `better-sqlite3` 的 native rebuild。若你在国内网络环境下载很慢，可配置 `ELECTRON_MIRROR`（见下方常见问题）。

## 项目结构

```
desktop/
  electron/                # Electron 主进程/预加载/数据库
    main.ts
    preload.ts
    db.ts
  src/
    views/
      MainView.tsx         # 导入与书架/目录/控制（配置页）
      OverlayView.tsx      # 阅读条本体
      OverlayToolbarView.tsx
      OverlaySettingsView.tsx
    styles.css
  scripts/
    ensure-electron.mjs    # 安装后确保 electron dist 存在（支持镜像）
    ensure-dist-electron.mjs
```

## 数据存储

- 数据库：`better-sqlite3`
- 文件位置：`app.getPath('userData')/app.db`
- 表结构与迁移：见 `electron/db.ts`

## 交互说明（Overlay）

- **点击正文**：显示工具栏（工具栏是独立窗口，避免被阅读条窗口裁剪）
- **拖动正文**：移动阅读条窗口（使用主进程读取全局鼠标位置，跟手且不受鼠标离窗影响）
- **拖动边缘/角**：缩放窗口（缩放时会将像素宽高反算为行/列，以适配当前字号）

## 常见问题（FAQ）

### 1) 安装时 electron 下载慢/失败

本项目在 `scripts/ensure-electron.mjs` 默认使用镜像：

- `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

你也可以在安装前显式设置：

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

### 2) 自动阅读时出现“残影”

透明窗口在部分 GPU/合成器组合下会出现残影。当前项目已在 `OverlayView` 中做了“清空一帧再绘制 + rAF 强制重绘”的兜底。

若仍遇到残影，可以进一步尝试：

- 降低透明度/加极弱背景（alpha 极小）
- 或在主进程禁用硬件加速（代价是 CPU 上升）

### 3) 为什么不用 `-webkit-app-region: drag` 覆盖全正文？

全正文 drag 会吞掉鼠标事件，影响点击/hover/遮罩/resize 等交互。本项目采用“正文手势识别 + 主进程全局鼠标位置移动窗口”的方式，实现“全区域可拖动窗口”且不破坏交互。

