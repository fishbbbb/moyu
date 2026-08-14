import { BrowserWindow, Menu, Tray, app, globalShortcut, ipcMain, nativeImage, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  deleteBook,
  createGroup,
  deleteBooks,
  deleteGroup,
  getBook,
  getItemContent,
  getLastProgress,
  getOverlaySession,
  importWebBook,
  importTxtBook,
  importWebItem,
  listBooks,
  searchBooks,
  listGroups,
  moveBooks,
  renameBook,
  updateBookTitle,
  renameGroup,
  setOverlaySession,
  updateItemContent,
  upsertProgress,
  type OverlaySession
} from './db'
import { BrowserBridge, ExtractError, WebContentExtractor } from './webContentExtractor'
import { sanitizeWebBookShelfTitle } from './webBookDisplay'

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let overlayToolbarWindow: BrowserWindow | null = null
let overlaySettingsWindow: BrowserWindow | null = null
let appTray: Tray | null = null
let rebuildTrayMenu: (() => void) | null = null
let isQuitting = false
/** 与渲染进程 overlay:cfg.contentProtection 同步；新建工具栏/设置窗时需再次应用 */
let overlayContentProtectionEnabled = false
let overlayMoveTimer: NodeJS.Timeout | null = null
let overlayMoveState: null | { winStart: { x: number; y: number }; mouseStart: { x: number; y: number } } = null
let overlayRepaintPulseTimers: NodeJS.Timeout[] = []
let auxSyncTimer: NodeJS.Timeout | null = null
let auxSyncPending = false
let overlayBoundsSaveTimer: NodeJS.Timeout | null = null

type SavedOverlayBounds = { x: number; y: number; width: number; height: number }

type IpcStringCheckOptions = {
  minLength?: number
  maxLength?: number
}

function overlayBoundsFilePath() {
  return path.join(app.getPath('userData'), 'overlay-bounds.json')
}

function loadSavedOverlayBounds(): SavedOverlayBounds | null {
  try {
    const raw = fs.readFileSync(overlayBoundsFilePath(), 'utf8')
    const j = JSON.parse(raw) as Partial<SavedOverlayBounds>
    if (
      typeof j?.x === 'number' &&
      Number.isFinite(j.x) &&
      typeof j?.y === 'number' &&
      Number.isFinite(j.y) &&
      typeof j?.width === 'number' &&
      Number.isFinite(j.width) &&
      typeof j?.height === 'number' &&
      Number.isFinite(j.height)
    ) {
      return {
        x: Math.floor(j.x),
        y: Math.floor(j.y),
        width: Math.max(220, Math.floor(j.width)),
        height: Math.max(40, Math.floor(j.height))
      }
    }
  } catch {
    /* first launch or corrupt file */
  }
  return null
}

function saveOverlayBoundsNow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  try {
    const b = overlayWindow.getBounds()
    fs.writeFileSync(
      overlayBoundsFilePath(),
      JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }),
      'utf8'
    )
  } catch {
    /* ignore disk errors */
  }
}

function isNonEmptyString(value: unknown, opts: IpcStringCheckOptions = {}) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed) return false
  if (typeof opts.minLength === 'number' && trimmed.length < opts.minLength) return false
  if (typeof opts.maxLength === 'number' && trimmed.length > opts.maxLength) return false
  return true
}

function isStringArray(value: unknown, opts: IpcStringCheckOptions = {}) {
  if (!Array.isArray(value)) return false
  return value.every((v) => isNonEmptyString(v, opts))
}

function isPlainObject(value: unknown) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isPrivateOrLocalHostname(hostname: string) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true

  // IPv4-mapped IPv6 → 递归检查嵌入的 IPv4
  if (host.startsWith('::ffff:')) return isPrivateOrLocalHostname(host.slice('::ffff:'.length))

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const parts = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
    const [a, b] = parts
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    return false
  }

  // IPv6 loopback / link-local / unique local（仅当含 ':' 时按 IP 判断，避免误伤 fc2.com 等域名）
  if (host.includes(':')) {
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
    if (host.startsWith('fe80:')) return true
    if (/^f[cd][0-9a-f]{0,2}:/i.test(host)) return true
  }
  return false
}

/** 仅允许可导航的公网 http(s)；拒绝私网、本机、带凭证 URL。 */
function isValidHttpUrl(value: unknown) {
  if (!isNonEmptyString(value, { maxLength: 4096 })) return false
  const raw = String(value).trim()
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (u.username || u.password) return false
  if (!u.hostname) return false
  if (isPrivateOrLocalHostname(u.hostname)) return false
  return true
}

function isChapterList(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) return false
  return value.every((it) => {
    if (!it || typeof it !== 'object') return false
    const chapter = it as { title?: unknown; url?: unknown }
    return isNonEmptyString(chapter.title, { maxLength: 200 }) && isValidHttpUrl(chapter.url)
  })
}

function assertTrustedIpcSender(evt: { sender: Electron.WebContents }) {
  const wc = evt.sender
  if (!wc || wc.isDestroyed()) throw new Error('IPC_FORBIDDEN')
  const trusted = [mainWindow, overlayWindow, overlayToolbarWindow, overlaySettingsWindow]
  const ok = trusted.some((w) => w != null && !w.isDestroyed() && w.webContents === wc)
  if (!ok) throw new Error('IPC_FORBIDDEN')
}

function ipcHandleTrusted(
  channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any
) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event)
    return listener(event, ...args)
  })
}

function ipcOnTrusted(channel: string, listener: (event: Electron.IpcMainEvent, ...args: any[]) => void) {
  ipcMain.on(channel, (event, ...args) => {
    try {
      assertTrustedIpcSender(event)
    } catch {
      return
    }
    listener(event, ...args)
  })
}

function isValidLayoutMode(value: unknown): value is 'capsule' | 'manage' {
  return value === 'capsule' || value === 'manage'
}

function isValidDeleteGroupMode(value: unknown): value is 'keepBooks' | 'deleteBooks' {
  return value === 'keepBooks' || value === 'deleteBooks'
}

function scheduleSaveOverlayBounds() {
  if (overlayBoundsSaveTimer) clearTimeout(overlayBoundsSaveTimer)
  overlayBoundsSaveTimer = setTimeout(() => {
    overlayBoundsSaveTimer = null
    saveOverlayBoundsNow()
  }, 280)
}

function defaultOverlayBounds(): SavedOverlayBounds {
  const wa = screen.getPrimaryDisplay().workArea
  const width = Math.min(760, Math.max(420, Math.floor(wa.width * 0.62)))
  const height = 56
  return {
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: wa.y,
    width,
    height
  }
}

function resolveOverlayCreateBounds(): SavedOverlayBounds {
  const saved = loadSavedOverlayBounds()
  return clampToWorkArea(saved ?? defaultOverlayBounds())
}

/** 找回阅读条：移到可见区、显示工具栏，并通知渲染进程高亮 */
function locateOverlayBar() {
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow()
  const w = overlayWindow
  if (!w || w.isDestroyed()) return { ok: false as const }

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wa = display.workArea
  const cur = w.getBounds()
  const width = clamp(cur.width, 220, wa.width)
  const height = clamp(cur.height, 40, Math.min(280, wa.height))
  const x = Math.round(wa.x + (wa.width - width) / 2)
  const y = Math.round(wa.y + Math.min(56, Math.max(12, Math.floor(wa.height * 0.06))))
  w.setBounds(clampToWorkArea({ x, y, width, height }), false)
  w.show()
  w.focus()
  saveOverlayBoundsNow()
  broadcastOverlayBounds()

  const tb = ensureOverlayToolbarWindow()
  positionOverlayToolbar()
  tb.showInactive()

  // 仅用边框高亮反馈，不再弹驻留提示（托盘点完菜单后用户已看到结果）
  w.webContents.send('overlay:locate', { at: Date.now() })
  return { ok: true as const }
}

function getWebImportUserAgent() {
  // 一些站点会针对 Electron/Headless UA 直接返回 403/空内容；这里固定为常见 Chrome UA。
  // 不追求与系统版本严格一致，只要“像正常浏览器”即可提高兼容性。
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
}

function webExtractErr(code: string, message: string) {
  // ipcRenderer.invoke 传递 Error 时通常只保留 message，因此把 code 编进 message 里。
  return new Error(`WEB_EXTRACT::${code}::${message}`)
}

function isWebExtractLoadTimeout(err: unknown): boolean {
  return err instanceof Error && err.message.includes('WEB_EXTRACT::LOAD_TIMEOUT')
}

function mapExtractErrorToWebError(err: unknown): Error {
  if (err instanceof ExtractError) {
    return webExtractErr(err.code, err.message)
  }
  if (err instanceof Error) return err
  return webExtractErr('UNKNOWN', '提取失败，请重试。')
}

async function waitWebContentsReady(wc: Electron.WebContents, timeoutMs = 20000) {
  if (!wc.isLoading()) return
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup()
      reject(webExtractErr('LOAD_TIMEOUT', '页面加载超时（可能网络较慢、站点拦截或需要科学上网）。'))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(t)
      wc.removeListener('did-finish-load', onDone)
      wc.removeListener('did-fail-load', onFail)
    }
    const onDone = () => {
      cleanup()
      resolve()
    }
    const onFail = () => {
      cleanup()
      reject(webExtractErr('LOAD_FAILED', '页面加载失败（可能被站点拦截/证书问题/网络错误）。'))
    }
    wc.once('did-finish-load', onDone)
    wc.once('did-fail-load', onFail)
  })
}

async function runStructuredExtraction(wc: Electron.WebContents, fallbackUrl?: string) {
  const t0 = Date.now()
  const durations: Record<string, number> = {
    waitReadyMs: 0,
    lazyLoadMs: 0,
    extractPageMs: 0,
    extractContentMs: 0,
    detectNavigationMs: 0,
    detectTocMs: 0,
    resolveNextMs: 0
  }
  const hostForLog = (() => {
    try {
      const raw = wc.getURL() || fallbackUrl || ''
      return raw ? new URL(raw).host : '(unknown-host)'
    } catch {
      return '(invalid-url)'
    }
  })()

  try {
    const s = Date.now()
    await waitWebContentsReady(wc)
    durations.waitReadyMs = Date.now() - s
  } catch (e) {
    durations.waitReadyMs = Date.now() - t0
    if (!isWebExtractLoadTimeout(e)) throw e
  }

  const bridge = new BrowserBridge(wc)
  try {
    const s = Date.now()
    await bridge.triggerLazyLoad(7)
    durations.lazyLoadMs = Date.now() - s
  } catch {
    // ignore warmup failures
  }
  try {
    const sPage = Date.now()
    const page = (await bridge.extractWhenReady<{ url: string; html: string; title: string }>(
      `({ url: location.href || '', html: document.documentElement.outerHTML || '', title: document.title || '' })`,
      { waitForImages: true, settleAfterMs: 250, timeoutMs: 5000, maxDomNodes: 5000 }
    )) as { url: string; html: string; title: string }
    durations.extractPageMs = Date.now() - sPage

    const pageUrl = String(page?.url || fallbackUrl || '')
    const extractor = new WebContentExtractor({ minTextLength: 200 })
    let extracted
    try {
      const sExtract = Date.now()
      extracted = await extractor.extractCurrentPageAsync(pageUrl, page?.html || '')
      durations.extractContentMs = Date.now() - sExtract
    } catch (err) {
      throw mapExtractErrorToWebError(err)
    }

    const sNav = Date.now()
    const nav = extractor.detectNavigation(page?.html || '', pageUrl)
    durations.detectNavigationMs = Date.now() - sNav

    const sToc = Date.now()
    const toc = extractor.detectTOC(pageUrl, page?.html || '')
    durations.detectTocMs = Date.now() - sToc

    const sNext = Date.now()
    const nextResolved = extractor.resolveNextChapter(pageUrl, toc.entries, nav)
    durations.resolveNextMs = Date.now() - sNext

    const totalMs = Date.now() - t0
    console.info('[web-import][timing] extraction ok', {
      host: hostForLog,
      totalMs,
      ...durations
    })

    return {
      pageUrl,
      pageTitle: String(page?.title || ''),
      extracted,
      nav,
      toc,
      nextResolved
    }
  } catch (err) {
    const totalMs = Date.now() - t0
    console.warn('[web-import][timing] extraction failed', {
      host: hostForLog,
      totalMs,
      ...durations,
      error: err instanceof Error ? err.message : String(err)
    })
    throw err
  }
}

function stopOverlayMove() {
  if (overlayMoveTimer) clearInterval(overlayMoveTimer)
  overlayMoveTimer = null
  overlayMoveState = null
}

function startOverlayMove() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  const b = overlayWindow.getBounds()
  overlayMoveState = {
    winStart: { x: b.x, y: b.y },
    mouseStart: screen.getCursorScreenPoint()
  }
  if (overlayMoveTimer) clearInterval(overlayMoveTimer)
  overlayMoveTimer = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayMoveState) return
    const cur = screen.getCursorScreenPoint()
    const x = Math.round(overlayMoveState.winStart.x + (cur.x - overlayMoveState.mouseStart.x))
    const y = Math.round(overlayMoveState.winStart.y + (cur.y - overlayMoveState.mouseStart.y))
    overlayWindow.setBounds({ ...overlayWindow.getBounds(), x, y }, false)
    syncAuxPositions()
  }, 16)
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function toRawLines(text: string) {
  const rawLines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((s) => s.replace(/\t/g, '    ').trimEnd())
  return rawLines.length > 0 ? rawLines : ['']
}

function getDevUrl() {
  return 'http://127.0.0.1:5173'
}

/** 渲染页 index（生产）；使用 pathToFileURL 以兼容 Windows 路径。 */
function getIndexFileUrl() {
  const indexPath = path.join(app.getAppPath(), 'dist', 'index.html')
  return pathToFileURL(indexPath).href
}

function getPreloadPath() {
  return path.join(app.getAppPath(), 'dist-electron', 'preload.js')
}

function applyOverlayContentProtection(enabled: boolean) {
  overlayContentProtectionEnabled = Boolean(enabled)
  const wins = [overlayWindow, overlayToolbarWindow, overlaySettingsWindow]
  for (const w of wins) {
    if (!w || w.isDestroyed()) continue
    try {
      w.setContentProtection(overlayContentProtectionEnabled)
    } catch { 
      // Linux 等环境可能不支持
    }
  }
}

function createMainWindow() {
  // 迷你书架：默认窄窗，不占桌面；需要时用户可自行拉宽
  const logo = loadAppLogo(128)
  mainWindow = new BrowserWindow({
    width: 340,
    height: 560,
    minWidth: 300,
    minHeight: 420,
    ...(logo.isEmpty() ? {} : { icon: logo }),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  attachWindowSecurity(mainWindow, 'local')

  // 点关闭：收进托盘，不退出（托盘菜单可「退出」）
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    mainWindow?.hide()
  })

  if (process.env.ELECTRON_DEV) {
    mainWindow.loadURL(`${getDevUrl()}/#/`)
    // 不默认停靠 DevTools，避免把迷你窗撑成「半屏调试台」；需要时 Cmd/Ctrl+Shift+I
  } else {
    mainWindow.loadURL(`${getIndexFileUrl()}#/`)
  }
}

function resolveAppAsset(...parts: string[]) {
  const candidates = [
    path.join(app.getAppPath(), 'assets', ...parts),
    path.join(process.resourcesPath, 'assets', ...parts),
    path.join(process.cwd(), 'assets', ...parts),
    path.join(__dirname, '..', 'assets', ...parts)
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch {
      /* ignore */
    }
  }
  return candidates[0]
}

function loadAppLogo(size: 16 | 32 | 128 = 32) {
  const file = size <= 16 ? 'logo-moyu-16.png' : size <= 32 ? 'logo-moyu-32.png' : 'logo-moyu-128.png'
  const p = resolveAppAsset(file)
  try {
    const img = nativeImage.createFromPath(p)
    if (!img.isEmpty()) return img
  } catch {
    /* fall through */
  }
  return nativeImage.createEmpty()
}

function attachWindowSecurity(win: BrowserWindow, mode: 'local' | 'web') {
  const wc = win.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))

  wc.on('will-navigate', (event, url) => {
    if (mode === 'web') {
      if (isValidHttpUrl(url)) return
    }
    event.preventDefault()
  })

  wc.on('will-redirect', (event, url) => {
    if (mode === 'web') {
      if (isValidHttpUrl(url)) return
    }
    event.preventDefault()
  })
}

function ensureTray() {
  if (appTray && !appTray.isDestroyed()) return appTray

  // 使用 vsix 墨鱼标；macOS 菜单栏用 template 图标，不再用「墨/yu」文字
  let icon = loadAppLogo(process.platform === 'darwin' ? 16 : 32)
  if (icon.isEmpty()) icon = nativeImage.createEmpty()
  if (process.platform === 'darwin' && !icon.isEmpty()) {
    try {
      icon.setTemplateImage(true)
    } catch {
      /* ignore */
    }
  }
  appTray = new Tray(icon)
  if (process.platform === 'darwin') {
    appTray.setTitle('')
  }
  appTray.setToolTip('墨鱼阅读器')
  const rebuildMenu = () => {
    const playing = Boolean(getOverlaySession()?.playing)
    const menu = Menu.buildFromTemplate([
      {
        label: '显示书架',
        click: () => {
          showMainLibrary()
        }
      },
      {
        // 「显示」与「找回」合并：显示 + 移到可见区，避免两项语义重叠
        label: '定位阅读条',
        click: () => {
          locateOverlayBar()
        }
      },
      {
        label: playing ? '暂停自动阅读' : '开始自动阅读',
        click: () => {
          const cur = getOverlaySession()
          if (!cur) {
            // 无会话时先打开书架，避免空点
            showMainLibrary()
            return
          }
          const next = { ...cur, playing: !playing }
          setOverlaySession(next)
          broadcastOverlaySession(next)
          overlayWindow?.show()
          rebuildMenu()
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
    appTray?.setContextMenu(menu)
  }
  rebuildMenu()
  rebuildTrayMenu = rebuildMenu
  appTray.on('click', () => {
    rebuildMenu()
    // Windows/Linux：单击托盘切换书架显隐；macOS 以菜单为主
    if (process.platform === 'darwin') return
    if (mainWindow?.isVisible()) mainWindow.hide()
    else showMainLibrary()
  })
  appTray.on('right-click', () => {
    rebuildMenu()
  })
  appTray.on('double-click', () => {
    showMainLibrary()
  })
  return appTray
}

function showMainLibrary() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
  }
  mainWindow?.show()
  mainWindow?.focus()
  if (process.platform === 'darwin') {
    try {
      app.show()
      app.focus({ steal: true })
    } catch {
      /* ignore */
    }
  }
}

function hideMainToTray() {
  ensureTray()
  mainWindow?.hide()
  if (process.platform === 'darwin') {
    // 主窗收起后，避免 Dock 激活把空窗顶回来；阅读条仍可独立显示
    try {
      /* keep running in menu bar */
    } catch {
      /* ignore */
    }
  }
  return { ok: true }
}

function createOverlayWindow() {
  const init = resolveOverlayCreateBounds()
  overlayWindow = new BrowserWindow({
    x: init.x,
    y: init.y,
    width: init.width,
    height: init.height,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: true
    }
  })
  attachWindowSecurity(overlayWindow, 'local')

  // 兜底：若渲染进程漏发 overlay:moveStop（例如 pointerup 丢失），
  // 主进程仍应在窗口状态变化时停止跟随，避免“窗口吸附鼠标导致无法操作其他应用”。
  overlayWindow.on('blur', () => {
    stopOverlayMove()
  })
  overlayWindow.on('hide', () => {
    stopOverlayMove()
  })
  overlayWindow.on('closed', () => {
    stopOverlayMove()
    overlayWindow = null
  })

  if (process.env.ELECTRON_DEV) {
    overlayWindow.loadURL(`${getDevUrl()}/#/overlay`)
  } else {
    overlayWindow.loadURL(`${getIndexFileUrl()}#/overlay`)
  }
  applyOverlayContentProtection(overlayContentProtectionEnabled)
}

function ensureOverlayToolbarWindow() {
  if (overlayToolbarWindow && !overlayToolbarWindow.isDestroyed()) return overlayToolbarWindow
  overlayToolbarWindow = new BrowserWindow({
    // 工具栏按钮可配置，宽度需要留足避免裁切
    width: 340,
    height: 64,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    // 关键：不抢走 overlay 焦点，否则 overlay blur 会把工具栏立刻收起
    focusable: false,
    show: false,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: true
    }
  })
  attachWindowSecurity(overlayToolbarWindow, 'local')
  if (process.env.ELECTRON_DEV) overlayToolbarWindow.loadURL(`${getDevUrl()}/#/overlay-toolbar`)
  else overlayToolbarWindow.loadURL(`${getIndexFileUrl()}#/overlay-toolbar`)
  overlayToolbarWindow.on('closed', () => {
    overlayToolbarWindow = null
  })
  applyOverlayContentProtection(overlayContentProtectionEnabled)
  return overlayToolbarWindow
}

/** 设置窗默认尺寸：固定外框高度，内容在框内滚动；绝不移动阅读条 */
const OVERLAY_SETTINGS_DEFAULT = { width: 300, height: 380 } as const
const OVERLAY_SETTINGS_MIN_H = 160

function ensureOverlaySettingsWindow() {
  if (overlaySettingsWindow && !overlaySettingsWindow.isDestroyed()) return overlaySettingsWindow
  overlaySettingsWindow = new BrowserWindow({
    width: OVERLAY_SETTINGS_DEFAULT.width,
    height: OVERLAY_SETTINGS_DEFAULT.height,
    minWidth: 280,
    minHeight: OVERLAY_SETTINGS_MIN_H,
    maxHeight: 520,
    useContentSize: true,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    show: false,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: true
    }
  })
  attachWindowSecurity(overlaySettingsWindow, 'local')
  if (process.env.ELECTRON_DEV) overlaySettingsWindow.loadURL(`${getDevUrl()}/#/overlay-settings`)
  else overlaySettingsWindow.loadURL(`${getIndexFileUrl()}#/overlay-settings`)
  overlaySettingsWindow.on('closed', () => {
    overlaySettingsWindow = null
  })
  // 设置窗失焦时收起（点击到其他应用/桌面/其他窗口）。
  // 避免与 overlay 侧的 blur-smart 逻辑产生竞态：这里在 settings 自己 blur 时才收起。
  overlaySettingsWindow.on('blur', () => {
    hideAuxWindows()
  })
  applyOverlayContentProtection(overlayContentProtectionEnabled)
  return overlaySettingsWindow
}

function clampToWorkArea(bounds: { x: number; y: number; width: number; height: number }) {
  const display = screen.getDisplayMatching(bounds)
  const wa = display.workArea
  // 先把尺寸压进工作区，避免 height > workArea 时 y 的 clamp 上下界倒置、外框被裁切
  const width = Math.min(Math.max(1, bounds.width), wa.width)
  const height = Math.min(Math.max(1, bounds.height), wa.height)
  const x = clamp(bounds.x, wa.x, wa.x + wa.width - width)
  const y = clamp(bounds.y, wa.y, wa.y + wa.height - height)
  return { ...bounds, x, y, width, height }
}

function positionOverlayToolbar() {
  if (!overlayWindow || !overlayToolbarWindow) return
  const ob = overlayWindow.getBounds()
  const tb = overlayToolbarWindow.getBounds()
  const display = screen.getDisplayMatching(ob)
  const wa = display.workArea
  const margin = 10
  const gap = 4
  let x = Math.round(ob.x + ob.width - tb.width - margin)
  let y = Math.round(ob.y - tb.height - gap)
  // 上方没有空间（阅读框贴顶）时：贴在阅读框下沿外侧，避免遮挡正文
  if (y < wa.y) {
    y = Math.round(ob.y + ob.height + gap)
  }
  overlayToolbarWindow.setBounds(clampToWorkArea({ x, y, width: tb.width, height: tb.height }), false)
}

/**
 * 按阅读条周围可用空间布局设置窗：
 * - 选上下空余更大的一侧
 * - 高度默认 380，空间不够则压缩到该侧可用高度（完整落在工作区内）
 * - 不改动 overlayWindow bounds
 */
function layoutOverlaySettings(args?: { width?: number; height?: number }) {
  if (!overlaySettingsWindow || overlaySettingsWindow.isDestroyed()) {
    return { ok: false as const, width: 0, height: 0, capped: false, side: 'below' as const }
  }
  const sb = overlaySettingsWindow.getBounds()
  const width = clamp(
    Math.round(Number(args?.width ?? sb.width) || OVERLAY_SETTINGS_DEFAULT.width),
    280,
    420
  )
  const preferredH = clamp(
    Math.round(Number(args?.height ?? OVERLAY_SETTINGS_DEFAULT.height) || OVERLAY_SETTINGS_DEFAULT.height),
    OVERLAY_SETTINGS_MIN_H,
    520
  )

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    const next = clampToWorkArea({ x: sb.x, y: sb.y, width, height: preferredH })
    overlaySettingsWindow.setBounds(next, false)
    return { ok: true as const, width: next.width, height: next.height, capped: next.height < preferredH, side: 'below' as const }
  }

  const ob = overlayWindow.getBounds()
  const display = screen.getDisplayMatching(ob)
  const wa = display.workArea
  const gap = 10
  const margin = 10
  const spaceBelow = Math.max(0, wa.y + wa.height - (ob.y + ob.height + gap))
  const spaceAbove = Math.max(0, ob.y - gap - wa.y)
  const placeBelow = spaceBelow >= spaceAbove
  const avail = placeBelow ? spaceBelow : spaceAbove

  // 有侧向空位：压到该侧可用高度；两侧都几乎没缝时，仍不碰阅读条，只在工作区内夹紧
  let height = preferredH
  if (avail > 0) {
    height = Math.min(preferredH, avail)
    height = Math.max(Math.min(OVERLAY_SETTINGS_MIN_H, avail), height)
  } else {
    height = Math.min(preferredH, wa.height)
  }

  let x = Math.round(ob.x + ob.width - width - margin)
  let y = placeBelow ? Math.round(ob.y + ob.height + gap) : Math.round(ob.y - height - gap)
  const next = clampToWorkArea({ x, y, width, height })
  overlaySettingsWindow.setBounds(next, false)
  return {
    ok: true as const,
    width: next.width,
    height: next.height,
    capped: next.height < preferredH - 1,
    side: placeBelow ? ('below' as const) : ('above' as const)
  }
}

function positionOverlaySettings() {
  layoutOverlaySettings()
}

function resizeOverlaySettings(args: { width?: number; height?: number }) {
  // 渲染进程只允许改宽；高度由默认值 + 可用空间决定，避免按内容撑破外框
  return layoutOverlaySettings({
    width: args?.width,
    height: OVERLAY_SETTINGS_DEFAULT.height
  })
}

function syncAuxPositions() {
  if (overlayToolbarWindow?.isVisible()) positionOverlayToolbar()
  if (overlaySettingsWindow?.isVisible()) positionOverlaySettings()
}

function requestSyncAuxPositions() {
  // 高频 move/resize 期间做轻节流，减少辅助窗抖动与“易位”
  if (auxSyncPending) return
  auxSyncPending = true
  if (auxSyncTimer) clearTimeout(auxSyncTimer)
  auxSyncTimer = setTimeout(() => {
    auxSyncPending = false
    syncAuxPositions()
  }, 33)
}

function hideAuxWindows() {
  overlayToolbarWindow?.hide()
  overlaySettingsWindow?.hide()
}

function broadcastOverlaySession(session: unknown) {
  overlayWindow?.webContents.send('overlay:session', session)
  overlayToolbarWindow?.webContents.send('overlay:session', session)
  overlaySettingsWindow?.webContents.send('overlay:session', session)
  try {
    rebuildTrayMenu?.()
  } catch {
    /* ignore */
  }
}

/** 书架删除书籍后：若阅读条正读着该书，清空会话避免后续 IPC 读库抛错 */
function clearOverlaySessionIfBooksRemoved(bookIds: string[]) {
  const idSet = new Set((bookIds ?? []).map(String).filter(Boolean))
  if (idSet.size === 0) return
  const cur = getOverlaySession()
  if (!cur?.bookId || !idSet.has(cur.bookId)) return
  setOverlaySession(null)
  broadcastOverlaySession(null)
  hideAuxWindows()
}

function broadcastOverlayBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  const b = overlayWindow.getBounds()
  overlayWindow.webContents.send('overlay:bounds', b)
  overlayToolbarWindow?.webContents.send('overlay:bounds', b)
  overlaySettingsWindow?.webContents.send('overlay:bounds', b)
}

function broadcastOverlayKMode(enabled: boolean) {
  overlayWindow?.webContents.send('overlay:kMode', { enabled: Boolean(enabled) })
  overlayToolbarWindow?.webContents.send('overlay:kMode', { enabled: Boolean(enabled) })
  overlaySettingsWindow?.webContents.send('overlay:kMode', { enabled: Boolean(enabled) })
}

function broadcastOverlayToast(payload: { type: 'error' | 'info'; message: string; detail?: string; durationMs?: number }) {
  overlayWindow?.webContents.send('overlay:toast', payload)
  overlayToolbarWindow?.webContents.send('overlay:toast', payload)
  overlaySettingsWindow?.webContents.send('overlay:toast', payload)
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+X', () => {
    if (!overlayWindow) return
    if (overlayWindow.isVisible()) overlayWindow.hide()
    else overlayWindow.show()
  })
}

app.whenReady().then(() => {
  const dockLogo = loadAppLogo(128)
  if (!dockLogo.isEmpty() && process.platform === 'darwin') {
    try {
      app.dock?.setIcon(dockLogo)
    } catch {
      /* ignore */
    }
  }
  createMainWindow()
  createOverlayWindow()
  ensureTray()
  registerShortcuts()

  overlayWindow?.on('move', requestSyncAuxPositions)
  overlayWindow?.on('resize', () => {
    requestSyncAuxPositions()
    scheduleSaveOverlayBounds()
  })
  overlayWindow?.on('moved', () => {
    syncAuxPositions()
    scheduleSaveOverlayBounds()
  })
  overlayWindow?.on('resized', () => {
    syncAuxPositions()
    scheduleSaveOverlayBounds()
  })
  overlayWindow?.on('show', () => {
    syncAuxPositions()
    broadcastOverlayBounds()
  })
  // Overlay 失焦时的收起逻辑已统一交给渲染进程（OverlayView）通过 IPC `overlay:auxHideAll` 控制，
  // 这里不再在主进程上监听 blur 直接隐藏，避免与设置窗/工具栏显示产生竞态。
  overlayWindow?.on('hide', () => {
    stopOverlayMove()
    hideAuxWindows()
    scheduleSaveOverlayBounds()
  })
  overlayWindow?.on('closed', () => {
    stopOverlayMove()
    overlayToolbarWindow?.destroy()
    overlaySettingsWindow?.destroy()
    overlayToolbarWindow = null
    overlaySettingsWindow = null
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
      createOverlayWindow()
    } else {
      showMainLibrary()
    }
  })
})

app.on('before-quit', () => {
  isQuitting = true
  saveOverlayBoundsNow()
})

app.on('window-all-closed', () => {
  // 有托盘时保持常驻；仅非 darwin 且用户主动退出时才结束
  if (process.platform !== 'darwin' && isQuitting) app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  try {
    appTray?.destroy()
  } catch {
    /* ignore */
  }
  appTray = null
})

ipcHandleTrusted('main:hideToTray', () => hideMainToTray())
ipcHandleTrusted('main:showLibrary', () => {
  showMainLibrary()
  return { ok: true }
})
ipcHandleTrusted('main:setLayoutMode', (_evt, args: { mode: 'capsule' | 'manage' }) => {
  if (!isValidLayoutMode(args?.mode)) throw new Error('INVALID_LAYOUT_MODE')
  if (args.mode === 'capsule') return hideMainToTray()
  showMainLibrary()
  return { ok: true }
})

ipcHandleTrusted('overlay:setConfig', (_evt, cfg: { opacity?: number; contentProtection?: boolean }) => {
  if (!overlayWindow) return
  if (typeof cfg?.opacity === 'number' && Number.isFinite(cfg.opacity)) overlayWindow.setOpacity(cfg.opacity)
  if (typeof cfg?.contentProtection === 'boolean') applyOverlayContentProtection(cfg.contentProtection)
})

ipcHandleTrusted('library:listBooks', () => {
  return { books: listBooks() }
})

ipcHandleTrusted('library:getBook', (_evt, args: { bookId: string }) => {
  const bookId = String(args?.bookId ?? '').trim()
  if (!isNonEmptyString(bookId, { maxLength: 128 })) throw new Error('INVALID_BOOK_ID')
  return getBook(bookId)
})

ipcHandleTrusted(
  'library:importTxt',
  (_evt, args: { title: string; sourceRef: string; items: Array<{ title: string; contentText: string }> }) => {
    const title = String(args?.title ?? '').trim()
    const sourceRef = String(args?.sourceRef ?? '').trim()
    const items = Array.isArray(args?.items) ? args.items : []
    if (!isNonEmptyString(title, { maxLength: 200 })) throw new Error('INVALID_TITLE')
    if (!isNonEmptyString(sourceRef, { maxLength: 2048 })) throw new Error('INVALID_SOURCE_REF')
    if (items.length === 0 || items.length > 500) throw new Error('INVALID_ITEMS')
    for (const it of items) {
      if (!isPlainObject(it)) throw new Error('INVALID_ITEMS')
      if (!isNonEmptyString((it as { title?: unknown }).title, { maxLength: 200 })) throw new Error('INVALID_ITEMS')
      if (!isNonEmptyString((it as { contentText?: unknown }).contentText, { minLength: 1, maxLength: 1_000_000 })) throw new Error('INVALID_ITEMS')
    }
    return importTxtBook({ title, sourceRef, items: items as Array<{ title: string; contentText: string }> })
  }
)

ipcHandleTrusted('library:renameBook', (_evt, args: { bookId: string; title: string }) => {
  const bookId = String(args?.bookId ?? '').trim()
  const title = String(args?.title ?? '').trim()
  if (!isNonEmptyString(bookId, { maxLength: 128 })) throw new Error('INVALID_BOOK_ID')
  if (!isNonEmptyString(title, { maxLength: 200 })) throw new Error('INVALID_TITLE')
  return renameBook(bookId, title)
})

ipcHandleTrusted('book:rename', (_evt, args: { bookId: string; newTitle: string }) => {
  const bookId = String(args?.bookId ?? '').trim()
  const newTitle = String(args?.newTitle ?? '').trim()
  if (!isNonEmptyString(bookId, { maxLength: 128 })) throw new Error('INVALID_BOOK_ID')
  return updateBookTitle(bookId, newTitle)
})

ipcHandleTrusted('book:delete', (_evt, args: { bookId: string }) => {
  const id = String(args?.bookId ?? '').trim()
  if (!isNonEmptyString(id, { maxLength: 128 })) throw new Error('INVALID_BOOK_ID')
  const res = deleteBook(id)
  clearOverlaySessionIfBooksRemoved([id])
  return res
})

ipcHandleTrusted('book:deleteMany', (_evt, args: { bookIds: string[] }) => {
  const bookIds = isStringArray(args?.bookIds, { maxLength: 128 }) ? args.bookIds.map((x) => String(x).trim()) : []
  if (!bookIds.length) throw new Error('INVALID_BOOK_IDS')
  const res = deleteBooks({ bookIds })
  clearOverlaySessionIfBooksRemoved(bookIds)
  return res
})

ipcHandleTrusted('book:search', (_evt, args: { query: string }) => {
  const query = String(args?.query ?? '')
  if (query.length > 500) throw new Error('INVALID_QUERY')
  return { books: searchBooks(query) }
})

ipcHandleTrusted('library:listGroups', () => {
  return { groups: listGroups() }
})

ipcHandleTrusted('library:createGroup', (_evt, args: { title: string; parentId?: string | null }) => {
  const title = String(args?.title ?? '').trim()
  const parentId = args?.parentId == null ? null : String(args.parentId).trim()
  if (!isNonEmptyString(title, { maxLength: 200 })) throw new Error('INVALID_TITLE')
  if (parentId !== null && !isNonEmptyString(parentId, { maxLength: 128 })) throw new Error('INVALID_PARENT')
  return createGroup({ title, parentId })
})

ipcHandleTrusted('library:renameGroup', (_evt, args: { groupId: string; title: string }) => {
  const groupId = String(args?.groupId ?? '').trim()
  const title = String(args?.title ?? '').trim()
  if (!isNonEmptyString(groupId, { maxLength: 128 })) throw new Error('INVALID_GROUP')
  if (!isNonEmptyString(title, { maxLength: 200 })) throw new Error('INVALID_TITLE')
  return renameGroup(groupId, title)
})

ipcHandleTrusted('library:deleteGroup', (_evt, args: { groupId: string; mode: 'keepBooks' | 'deleteBooks' }) => {
  const groupId = String(args?.groupId ?? '').trim()
  const mode = args?.mode
  if (!isNonEmptyString(groupId, { maxLength: 128 })) throw new Error('INVALID_GROUP')
  if (!isValidDeleteGroupMode(mode)) throw new Error('INVALID_DELETE_MODE')
  const res = deleteGroup({ groupId, mode })
  if (Array.isArray(res.deletedBookIds) && res.deletedBookIds.length) {
    clearOverlaySessionIfBooksRemoved(res.deletedBookIds)
  }
  return res
})

ipcHandleTrusted('library:moveBooks', (_evt, args: { bookIds: string[]; groupId: string | null }) => {
  const bookIds = isStringArray(args?.bookIds, { maxLength: 128 }) ? args.bookIds.map((x) => String(x).trim()) : []
  const groupId = args?.groupId == null ? null : String(args.groupId).trim()
  if (groupId !== null && !isNonEmptyString(groupId, { maxLength: 128 })) throw new Error('INVALID_GROUP')
  return moveBooks({ bookIds, groupId })
})

ipcHandleTrusted('library:deleteBooks', (_evt, args: { bookIds: string[] }) => {
  const bookIds = isStringArray(args?.bookIds, { maxLength: 128 }) ? args.bookIds.map((x) => String(x).trim()) : []
  if (!bookIds.length) throw new Error('INVALID_BOOK_IDS')
  const res = deleteBooks({ bookIds })
  clearOverlaySessionIfBooksRemoved(bookIds)
  return res
})

ipcHandleTrusted(
  'library:importWebItem',
  (_evt, args: { title: string; sourceUrl: string; contentText: string; domain: string | null; bookId?: string | null }) => {
    const title = sanitizeWebBookShelfTitle(String(args?.title ?? ''))
    const sourceUrl = String(args?.sourceUrl ?? '').trim()
    const contentText = String(args?.contentText ?? '').trim()
    const domain = args?.domain == null ? null : String(args.domain).trim() || null
    const bookId = args?.bookId == null ? null : String(args.bookId).trim() || null
    if (!isNonEmptyString(title, { maxLength: 200 })) throw new Error('INVALID_TITLE')
    if (!isValidHttpUrl(sourceUrl)) throw new Error('INVALID_URL')
    if (!isNonEmptyString(contentText, { minLength: 1, maxLength: 1_000_000 })) throw new Error('EMPTY_CONTENT')
    if (domain !== null && !isNonEmptyString(domain, { maxLength: 255 })) throw new Error('INVALID_DOMAIN')
    if (bookId !== null && !isNonEmptyString(bookId, { maxLength: 128 })) throw new Error('INVALID_BOOK_ID')
    return importWebItem({ title, sourceUrl, contentText, domain, bookId })
  }
)

ipcHandleTrusted(
  'library:importWebBook',
  (
    _evt,
    args: { bookTitle: string; detailUrl: string; domain: string | null; introText?: string | null; chapters: Array<{ title: string; url: string }> }
  ) => {
    const detailUrl = String(args?.detailUrl ?? '').trim()
    const bookTitle = sanitizeWebBookShelfTitle(String(args?.bookTitle ?? ''))
    const chapters = Array.isArray(args?.chapters) ? args.chapters : []
    const introText = args?.introText == null ? null : String(args.introText).trim() || null
    const domain = args?.domain == null ? null : String(args.domain).trim() || null
    if (!isNonEmptyString(bookTitle, { maxLength: 200 })) throw new Error('INVALID_TITLE')
    if (!isValidHttpUrl(detailUrl)) throw new Error('INVALID_URL')
    if (domain !== null && !isNonEmptyString(domain, { maxLength: 255 })) throw new Error('INVALID_DOMAIN')
    if (introText !== null && !isNonEmptyString(introText, { maxLength: 20000 })) throw new Error('INVALID_INTRO')
    if (!isChapterList(chapters)) throw new Error('INVALID_TOC')
    return importWebBook({ bookTitle, detailUrl, domain, introText, chapters })
  }
)

ipcHandleTrusted('library:updateItemContent', (_evt, args: { itemId: string; contentText: string }) => {
  const itemId = String(args?.itemId ?? '').trim()
  const contentText = String(args?.contentText ?? '').trim()
  if (!isNonEmptyString(itemId, { maxLength: 128 })) throw new Error('INVALID_ITEM_ID')
  if (!isNonEmptyString(contentText, { minLength: 1, maxLength: 1_000_000 })) throw new Error('EMPTY_CONTENT')
  return updateItemContent({ itemId, contentText })
})

let webWindow: BrowserWindow | null = null

function ensureWebWindow() {
  if (webWindow && !webWindow.isDestroyed()) return webWindow
  webWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
      // 不可信网页：禁止挂应用 preload，避免暴露 window.api
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: 'persist:web-import'
    }
  })
  attachWindowSecurity(webWindow, 'web')
  try {
    webWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false)
    })
  } catch {
    /* ignore */
  }
  webWindow.on('closed', () => {
    webWindow = null
  })
  return webWindow
}

ipcHandleTrusted('web:open', async (_evt, args: { url: string }) => {
  if (!args?.url) throw new Error('INVALID_URL')
  const w = ensureWebWindow()
  const url = String(args.url).trim()
  if (!isValidHttpUrl(url)) throw new Error('INVALID_URL')
  const ua = getWebImportUserAgent()
  w.webContents.setUserAgent(ua)
  let origin = ''
  try {
    origin = new URL(url).origin
  } catch {
    origin = ''
  }
  const extraHeaders = [
    'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
    origin ? `Referer: ${origin}/` : ''
  ]
    .filter(Boolean)
    .join('\n')
  await w.loadURL(url, { userAgent: ua, extraHeaders })
  w.show()
  return { ok: true }
})

ipcHandleTrusted('web:extract', async () => {
  if (!webWindow || webWindow.isDestroyed()) {
    throw webExtractErr('NO_WEB_WINDOW', '未检测到已打开的网页窗口，请先点击“打开网页”。')
  }
  const wc = webWindow.webContents
  const { pageUrl, extracted } = await runStructuredExtraction(wc, wc.getURL())
  const contentText = String(extracted.textContent || '').trim()
  const title = String(extracted.title || '')
  const url = String(pageUrl || '')

  let domain: string | null = null
  try {
    if (url) domain = new URL(url).hostname || null
  } catch {
    domain = null
  }

  if (!url) throw webExtractErr('NO_URL', '未能获取当前页面 URL。')
  if (!contentText) throw webExtractErr('NO_MAIN_CONTENT', '未识别到正文，请切换章节页或使用手动框选。')

  const previewLines = contentText.split('\n').map((s) => s.trim()).filter(Boolean)
  const preview = previewLines.slice(0, 12).join('\n')

  return {
    title: sanitizeWebBookShelfTitle(title),
    url,
    domain,
    contentText,
    preview,
    extractor: extracted.source || 'readability',
    extractDebug: extracted.debug ?? null
  }
})

async function loadUrlInWebWindow(url: string) {
  if (!isValidHttpUrl(url)) throw webExtractErr('INVALID_URL', '无效或不安全的 URL。')
  const w = ensureWebWindow()
  const ua = getWebImportUserAgent()
  w.webContents.setUserAgent(ua)
  let origin = ''
  try {
    origin = new URL(url).origin
  } catch {
    origin = ''
  }
  const extraHeaders = [
    'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
    origin ? `Referer: ${origin}/` : ''
  ]
    .filter(Boolean)
    .join('\n')
  await w.loadURL(url, { userAgent: ua, extraHeaders })
  return w
}

type EnsureWebItemResult = {
  contentText: string | null
  nextResolved: import('./webContentExtractor').ResolvedNextChapter | null
  fetchError?: string
}

/** 网页导入书籍：章节正文为空时按 sourceUrl 拉取并写库；同时返回下一章解析结果供阅读条展示候选。 */
async function ensureWebItemContentFromSource(itemId: string): Promise<EnsureWebItemResult> {
  try {
    const { item } = getItemContent(itemId)
    const existing = String(item.contentText ?? '').trim()
    if (existing.length > 0) {
      return { contentText: existing, nextResolved: null }
    }
    const url = String(item.sourceUrl ?? '').trim()
    if (!url || !isValidHttpUrl(url)) {
      return { contentText: null, nextResolved: null, fetchError: 'NO_SOURCE_URL' }
    }
    const w = await loadUrlInWebWindow(url)
    w.show()
    const wc = w.webContents
    const { extracted, nextResolved } = await runStructuredExtraction(wc, url)
    const contentText = String(extracted.textContent ?? '').trim()
    if (!contentText) {
      return { contentText: null, nextResolved: nextResolved ?? null, fetchError: 'EMPTY_CONTENT' }
    }
    updateItemContent({ itemId, contentText })
    return { contentText, nextResolved: nextResolved ?? null }
  } catch (e) {
    return {
      contentText: null,
      nextResolved: null,
      fetchError: e instanceof Error ? e.message : String(e)
    }
  }
}

function mergeOverlayWebNextFromEnsure(
  ensured: EnsureWebItemResult,
  item: { sourceUrl: string | null }
): Pick<OverlaySession, 'webNextCandidates' | 'webChapterSourceUrl'> {
  const cands = ensured.nextResolved?.needsConfirmation ? ensured.nextResolved.candidates : undefined
  return {
    webNextCandidates: cands?.length ? cands : undefined,
    webChapterSourceUrl: item.sourceUrl ?? undefined
  }
}

const OVERLAY_FETCH_FAILED_LINE =
  '（本章正文未能自动获取：可能需登录/付费，或站点反爬。请回到主窗口在「网页导入」中打开该章节页处理。）'

function resolveOverlayLinesWithEnsure(itemContentText: string, ensured: EnsureWebItemResult): string[] {
  let lines = toRawLines(itemContentText)
  if (!lines.some((l) => l.trim())) {
    lines = [OVERLAY_FETCH_FAILED_LINE]
    broadcastOverlayToast({
      type: 'error',
      message: '本章提取失败',
      detail: ensured.fetchError
    })
    return lines
  }

  if (ensured.nextResolved?.needsConfirmation && ensured.nextResolved.candidates?.length) {
    broadcastOverlayToast({
      type: 'info',
      message: '下一章链接不够确定，可在下方候选中打开网页确认'
    })
  }
  return lines
}

ipcHandleTrusted('web:extractAtUrl', async (_evt, args: { url: string }) => {
  const url = String(args?.url ?? '').trim()
  if (!isValidHttpUrl(url)) throw webExtractErr('INVALID_URL', '无效或不安全的 URL。')
  const w = await loadUrlInWebWindow(url)
  w.show()
  const wc = w.webContents
  const { pageUrl, extracted } = await runStructuredExtraction(wc, url)
  const title = String(extracted.title ?? '')
  const contentText = String(extracted.textContent ?? '').trim()
  let domain: string | null = null
  try {
    if (pageUrl) domain = new URL(pageUrl).hostname || null
  } catch {
    domain = null
  }
  if (!pageUrl) throw webExtractErr('NO_URL', '未能获取当前页面 URL。')
  if (!contentText) throw webExtractErr('NO_MAIN_CONTENT', '未识别到正文，请切换章节页或使用手动框选。')
  const previewLines = contentText.split('\\n').map((s: string) => s.trim()).filter(Boolean)
  const preview = previewLines.slice(0, 12).join('\\n')
  return {
    title: sanitizeWebBookShelfTitle(title),
    url: pageUrl,
    domain,
    contentText,
    preview,
    extractor: extracted.source || 'readability',
    extractDebug: extracted.debug ?? null
  }
})


ipcHandleTrusted('web:extractStructuredAtUrl', async (_evt, args: { url: string }) => {
  const url = String(args?.url ?? '').trim()
  if (!isValidHttpUrl(url)) throw webExtractErr('INVALID_URL', '无效或不安全的 URL。')

  const w = await loadUrlInWebWindow(url)
  w.show()
  const wc = w.webContents
  const { pageUrl, pageTitle, extracted, nav, toc, nextResolved } = await runStructuredExtraction(wc, url)

  const displayTitle = sanitizeWebBookShelfTitle(String(extracted.title || pageTitle || '未命名网页'))

  return {
    url: pageUrl || url,
    title: displayTitle,
    content: {
      title: displayTitle,
      content: extracted.content,
      textContent: extracted.textContent,
      excerpt: extracted.textContent.slice(0, 180),
      author: undefined,
      publishedDate: undefined,
      wordCount: extracted.length
    },
    chapters: toc.entries || [],
    nextChapterUrl: nextResolved.needsConfirmation ? undefined : (nextResolved.nextUrl ?? nav.nextUrl),
    nextChapterNeedsConfirmation: Boolean(nextResolved.needsConfirmation),
    nextChapterCandidates: nextResolved.candidates ?? [],
    nextChapterConfidence: nextResolved.nextConfidence,
    nextChapterReason: nextResolved.nextReason,
    nextChapterSource: nextResolved.source,
    prevChapterUrl: nav.prevUrl,
    tocUrlCandidate: toc.tocUrlCandidate,
    isTocPage: toc.isTocPage,
    tocStatus: toc.tocStatus,
    tocSource: toc.tocSource,
    extractor: extracted.source || 'readability',
    extractDebug: {
      content: extracted.debug ?? null,
      toc: {
        status: toc.tocStatus,
        source: toc.tocSource,
        entryCount: toc.entries.length,
        isTocPage: toc.isTocPage
      },
      navigation: {
        nextConfidence: nav.nextConfidence,
        nextReason: nav.nextReason,
        prevConfidence: nav.prevConfidence,
        prevReason: nav.prevReason
      },
      next: nextResolved
    }
  }
})

ipcHandleTrusted('web:refresh', async () => {
  if (!webWindow || webWindow.isDestroyed()) {
    throw webExtractErr('NO_WEB_WINDOW', '未检测到已打开的网页窗口，请先点击“打开网页”。')
  }
  const wc = webWindow.webContents
  await wc.reloadIgnoringCache()
  await waitWebContentsReady(wc)
  return { ok: true, url: wc.getURL() }
})

ipcHandleTrusted(
  'web:extractFromSelection',
  async (
    _evt,
    args: {
      rect?: { x: number; y: number; width: number; height: number }
    }
  ) => {
    if (!webWindow || webWindow.isDestroyed()) {
      throw webExtractErr('NO_WEB_WINDOW', '未检测到已打开的网页窗口，请先点击“打开网页”。')
    }
    const wc = webWindow.webContents
    await waitWebContentsReady(wc)

    const rectArg = JSON.stringify(args?.rect ?? null)
    const pageSelection = (await wc.executeJavaScript(
      `(() => {
        const rect = ${rectArg};
        const normalize = (s) => String(s || '').trim();
        const fromCurrentSelection = () => {
          const sel = window.getSelection?.();
          if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return '';
          const box = document.createElement('div');
          for (let i = 0; i < sel.rangeCount; i += 1) {
            box.appendChild(sel.getRangeAt(i).cloneContents());
          }
          return box.innerHTML || '';
        };

        const intersects = (a, b) => !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
        const pickByRect = () => {
          if (!rect || typeof rect.x !== 'number') return '';
          const target = {
            left: rect.x,
            top: rect.y,
            right: rect.x + Math.max(0, rect.width || 0),
            bottom: rect.y + Math.max(0, rect.height || 0)
          };
          const candidates = Array.from(document.querySelectorAll('article, main, section, div, p'))
            .map((el) => ({ el, box: el.getBoundingClientRect() }))
            .filter((it) => it.box.width > 0 && it.box.height > 0 && intersects(it.box, target))
            .filter((it) => normalize(it.el.textContent).length >= 20)
            .sort((a, b) => (b.box.width * b.box.height) - (a.box.width * a.box.height))
            .slice(0, 120);

          if (!candidates.length) return '';
          const wrap = document.createElement('div');
          for (const item of candidates) {
            wrap.appendChild(item.el.cloneNode(true));
          }
          return wrap.innerHTML || '';
        };

        const collectByInteractiveRect = () => new Promise((resolve) => {
          const existing = document.getElementById('__mf_rect_overlay__');
          if (existing) existing.remove();

          const overlay = document.createElement('div');
          overlay.id = '__mf_rect_overlay__';
          overlay.style.position = 'fixed';
          overlay.style.left = '0';
          overlay.style.top = '0';
          overlay.style.right = '0';
          overlay.style.bottom = '0';
          overlay.style.zIndex = '2147483647';
          overlay.style.cursor = 'crosshair';
          overlay.style.background = 'rgba(30,41,59,0.08)';
          overlay.style.userSelect = 'none';

          const hint = document.createElement('div');
          hint.textContent = '拖拽框选正文区域，Esc 取消';
          hint.style.position = 'fixed';
          hint.style.left = '12px';
          hint.style.top = '12px';
          hint.style.padding = '6px 10px';
          hint.style.background = 'rgba(0,0,0,0.72)';
          hint.style.color = '#fff';
          hint.style.borderRadius = '8px';
          hint.style.fontSize = '12px';
          hint.style.pointerEvents = 'none';
          overlay.appendChild(hint);

          const box = document.createElement('div');
          box.style.position = 'fixed';
          box.style.border = '2px solid #3b82f6';
          box.style.background = 'rgba(59,130,246,0.12)';
          box.style.display = 'none';
          box.style.pointerEvents = 'none';
          overlay.appendChild(box);

          document.documentElement.appendChild(overlay);

          let sx = 0;
          let sy = 0;
          let drawing = false;

          const cleanup = () => {
            document.removeEventListener('keydown', onKeyDown, true);
            overlay.removeEventListener('mousedown', onDown, true);
            overlay.removeEventListener('mousemove', onMove, true);
            overlay.removeEventListener('mouseup', onUp, true);
            overlay.remove();
          };

          const toRect = (x1, y1, x2, y2) => ({
            left: Math.min(x1, x2),
            top: Math.min(y1, y2),
            right: Math.max(x1, x2),
            bottom: Math.max(y1, y2)
          });

          const collectByRect = (target) => {
            const intersects = (a, b) => !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
            const candidates = Array.from(document.querySelectorAll('article, main, section, div, p'))
              .map((el) => ({ el, box: el.getBoundingClientRect() }))
              .filter((it) => it.box.width > 0 && it.box.height > 0 && intersects(it.box, target))
              .filter((it) => normalize(it.el.textContent).length >= 20)
              .sort((a, b) => (b.box.width * b.box.height) - (a.box.width * a.box.height))
              .slice(0, 160);
            if (!candidates.length) return '';
            const wrap = document.createElement('div');
            for (const item of candidates) wrap.appendChild(item.el.cloneNode(true));
            return wrap.innerHTML || '';
          };

          const onKeyDown = (e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              cleanup();
              resolve('');
            }
          };

          const onDown = (e) => {
            if (e.button !== 0) return;
            drawing = true;
            sx = e.clientX;
            sy = e.clientY;
            box.style.display = 'block';
            box.style.left = String(sx) + 'px';
            box.style.top = String(sy) + 'px';
            box.style.width = '0px';
            box.style.height = '0px';
            e.preventDefault();
          };

          const onMove = (e) => {
            if (!drawing) return;
            const r = toRect(sx, sy, e.clientX, e.clientY);
            box.style.left = String(r.left) + 'px';
            box.style.top = String(r.top) + 'px';
            box.style.width = String(Math.max(0, r.right - r.left)) + 'px';
            box.style.height = String(Math.max(0, r.bottom - r.top)) + 'px';
            e.preventDefault();
          };

          const onUp = (e) => {
            if (!drawing) return;
            drawing = false;
            const r = toRect(sx, sy, e.clientX, e.clientY);
            cleanup();
            if ((r.right - r.left) < 12 || (r.bottom - r.top) < 12) {
              resolve('');
              return;
            }
            resolve(collectByRect(r));
            e.preventDefault();
          };

          document.addEventListener('keydown', onKeyDown, true);
          overlay.addEventListener('mousedown', onDown, true);
          overlay.addEventListener('mousemove', onMove, true);
          overlay.addEventListener('mouseup', onUp, true);
        });

        return Promise.resolve().then(async () => {
          let selectedHtml = fromCurrentSelection() || pickByRect();
          if (!selectedHtml) selectedHtml = await collectByInteractiveRect();
          return {
            url: location.href || '',
            title: document.title || '',
            selectedHtml
          };
        });
      })()`,
      true
    )) as { url: string; title: string; selectedHtml: string }

    const url = String(pageSelection?.url ?? '')
    const title = String(pageSelection?.title ?? '')
    const selectedHtml = String(pageSelection?.selectedHtml ?? '')
    if (!selectedHtml.trim()) {
      throw webExtractErr('MANUAL_SELECTION_EMPTY', '未检测到选区内容，请先框选正文后重试。')
    }

    const extractor = new WebContentExtractor({ minTextLength: 200 })
    const extracted = extractor.extractFromSelectedHtml(url || wc.getURL(), selectedHtml, title)
    if (!extracted.textContent || extracted.length < 20) {
      throw webExtractErr('MANUAL_SELECTION_TOO_SHORT', '选区内容过短，请扩大选区后重试。')
    }

    let domain: string | null = null
    try {
      if (url) domain = new URL(url).hostname || null
    } catch {
      domain = null
    }

    return {
      title: sanitizeWebBookShelfTitle(String(extracted.title || title || '未命名网页')),
      url: url || wc.getURL(),
      domain,
      contentText: extracted.textContent,
      contentHtml: extracted.content,
      preview: extracted.textContent.slice(0, 800),
      extractor: 'manual-selection'
    }
  }
)

ipcHandleTrusted('web:extractBookDetail', async () => {
  if (!webWindow || webWindow.isDestroyed()) {
    throw webExtractErr('NO_WEB_WINDOW', '未检测到已打开的网页窗口，请先点击“打开网页”。')
  }
  const wc = webWindow.webContents
  await waitWebContentsReady(wc)

  const extractOnce = async () => {
    return (await wc.executeJavaScript(`(() => {
      const rawUrl = location.href || '';
      const parseUrl = (u) => { try { return new URL(u); } catch { return null; } };
      const abs = (href) => { try { return new URL(href, location.href).toString(); } catch { return ''; } };

      const u0 = parseUrl(rawUrl);
      const host = u0?.hostname || '';

      const pickBookTitle = () => {
        const tryClean = (raw) => {
          const s = String(raw || '').replace(/\\s+/g, ' ').trim();
          if (!s) return '';
          const m = s.match(/《[^》]+》/);
          if (m) return m[0].trim();
          let x = s.replace(/【[^】]*】/g, ' ').replace(/\\s+/g, ' ').trim();
          const head = x.split('_')[0]?.trim();
          if (head && head.length >= 2 && head.length < 96) x = head;
          x = x.replace(/\\s*[-|｜]\\s*.{0,48}文学城.*$/i, '').trim();
          return x || s;
        };
        const h1 = (document.querySelector('h1')?.textContent || '').trim();
        if (h1) {
          const c = tryClean(h1);
          if (c) return c;
        }
        const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
        if (og.trim()) {
          const c = tryClean(og.trim());
          if (c) return c;
        }
        const t = (document.title || '').trim();
        if (!t) return '';
        return tryClean(t) || t.replace(/_.*$/, '').replace(/\\|.*$/, '').trim();
      };

      const pickIntro = () => {
        const og = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
        const md = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
        const txt = (document.querySelector('#intro,.intro,.book-intro,.desc,.description')?.textContent || '');
        const intro = og || md || txt;
        return String(intro || '').replace(/\\s+/g,' ').trim();
      };

      const bookTitle = pickBookTitle() || '未命名网页';
      const introText = pickIntro();

      // Normalize detailUrl (generic: drop hash)
      let detailUrl = rawUrl;
      if (u0) {
        const u = new URL(u0.toString());
        u.hash = '';
        detailUrl = u.toString();
      }

      const isLikelyChapterText = (() => {
        const t = (document.title || '') + ' ' + (document.querySelector('h1')?.textContent || '');
        return /第\\s*\\d+\\s*[章回节]|chapter\\s*\\d+/i.test(t);
      })();

      const findTocLink = () => {
        const candidates = Array.from(document.querySelectorAll('a[href]'))
          .map((a) => ({ t: (a.textContent || '').trim(), u: abs(a.getAttribute('href') || '') }))
          .filter((x) => x.u && x.t && x.t.length <= 50);
        const keywords = /(目录|章节|章节列表|返回目录|书页|回目录|catalog|toc|chapters)/i;
        const hit = candidates.find((x) => keywords.test(x.t));
        if (hit?.u) return hit.u;
        // breadcrumb: take the previous link near current position
        const breadcrumb = Array.from(document.querySelectorAll('nav a[href], .breadcrumb a[href], .crumb a[href]')).pop();
        const u = breadcrumb ? abs(breadcrumb.getAttribute('href') || '') : '';
        return u || '';
      };

      const isChapterCandidateText = (t) => {
        const s = String(t || '').trim();
        if (!s) return false;
        if (s.length > 80) return false;
        if (/^(上一章|下一章|上一页|下一页|返回|目录|书页|首页|登录|注册)$/i.test(s)) return false;
        return /第\\s*[零一二三四五六七八九十百千0-9]+\\s*[章回节卷]|chapter\\s*\\d+/i.test(s) || s.length <= 20;
      };

      const normalizeForGroup = (u) => {
        const uu = parseUrl(u);
        if (!uu) return null;
        uu.hash = '';
        // only keep stable query keys for grouping
        const params = Array.from(uu.searchParams.keys()).sort();
        const keep = params.slice(0, 6);
        const q = keep.map((k) => k + '=' + uu.searchParams.get(k)).join('&');
        return uu.origin + uu.pathname + (q ? '?' + q : '');
      };

      // --- site adapters ---
      const adapters = [];

      adapters.push({
        match: () => u0 && /(^|\\.)jjwxc\\.net$/i.test(host) && /\\/onebook\\.php$/i.test(u0.pathname),
        run: () => {
          const nid = u0.searchParams.get('novelid') || '';
          if (!nid) return null;
          // normalize to detailUrl without chapterid
          // do not rely on protocol for filtering; some chapter links are http:// on the page
          const baseHost = u0.hostname;
          const basePath = u0.pathname;
          const baseProtocol = u0.protocol || 'https:';
          const baseOrigin = baseProtocol + '//' + baseHost;
          detailUrl = baseOrigin + basePath + '?novelid=' + encodeURIComponent(nid);

          const allAnchors = Array.from(document.querySelectorAll('a[href]'))
            .map((a) => {
              const href = a.getAttribute('href') || '';
              const url = abs(href);
              const t = (a.textContent || '').trim();
              return { t, u: url, href };
            });

          const getParamCI = (uu, name) => {
            const needle = String(name || '').toLowerCase();
            for (const [k, v] of uu.searchParams.entries()) {
              if (String(k || '').toLowerCase() === needle) return String(v || '');
            }
            return '';
          };

          const aList = allAnchors.filter((x) => {
            if (!x.u) return false;
            const uu = parseUrl(x.u);
            if (!uu) return false;
            // accept both http/https as long as host/path points to onebook
            return uu.hostname === baseHost && /\\/onebook\\.php$/i.test(uu.pathname || '');
          });

          const chaptersRaw = aList
            .map((x) => {
              const uu = parseUrl(x.u);
              if (!uu) return null;

              const nid2 = getParamCI(uu, 'novelid');
              let cid = getParamCI(uu, 'chapterid');

              // 兜底：参数异常时直接从 URL 正则提取 chapterid
              if (!cid) {
                const m = /(?:[?&])chapterid=(\d+)/i.exec(x.u) || /(?:[?&])chapterid=(\d+)/i.exec(x.href || '');
                if (m?.[1]) cid = m[1];
              }

              if (!nid2 || String(nid2) !== String(nid)) return null;
              if (!cid) return null;

              const nCid = Number(cid);
              if (!Number.isFinite(nCid) || nCid <= 0) return null;

              const t = String(x.t || '').trim();
              const title = t && t.length <= 120 ? t : ('第' + String(nCid) + '章');

              return {
                t: title,
                u: baseOrigin + basePath + '?novelid=' + encodeURIComponent(nid) + '&chapterid=' + encodeURIComponent(String(nCid)),
                cid: nCid
              };
            })
            .filter(Boolean);

          const byCid = new Map();
          for (const c of chaptersRaw) {
            if (!byCid.has(c.cid)) byCid.set(c.cid, { t: c.t, u: c.u, cid: c.cid });
          }
          const chapters = Array.from(byCid.values())
            .sort((a, b) => a.cid - b.cid)
            .slice(0, 600)
            .map((c) => ({ t: c.t, u: c.u }));

          const debug = {
            adapter: 'jjwxc',
            rawUrl,
            baseHost,
            basePath,
            anchorsTotal: allAnchors.length,
            anchorsMatchedOnebookPath: aList.length,
            chapterCandidates: chaptersRaw.length,
            sampleChapterLinks: allAnchors
              .filter((x) => /chapterid=\\d+/i.test(x.u) || /chapterid=\\d+/i.test(x.href || ''))
              .slice(0, 8)
              .map((x) => ({ t: x.t, u: x.u }))
          };
          return { detailUrl, bookTitle, introText, chapters, debug };
        }
      });

      for (const ad of adapters) {
        try {
          if (ad.match()) {
            const out = ad.run();
            if (out?.chapters?.length) return out;
          }
        } catch {
          // ignore adapter failures, fallback to generic
        }
      }

      // --- generic toc extraction ---
      const containers = ['#list','.chapter','.chapters','.catalog','.toc','.book-chapter','.mulu','main','body'];
      let best = null;
      let bestCount = 0;
      for (const sel of containers) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const links = Array.from(el.querySelectorAll('a[href]'));
        if (links.length > bestCount) { best = el; bestCount = links.length; }
      }
      const root = best || document.body;
      const links = Array.from(root.querySelectorAll('a[href]'))
        .map((a) => ({ t: (a.textContent||'').trim(), u: abs(a.getAttribute('href')||'') }))
        .filter((x) => x.u && x.t && x.t.length >= 1 && x.t.length <= 120);

      const origin = u0?.origin || '';
      const filtered = links.filter((x) => !origin || x.u.startsWith(origin));

      // group by normalized url signature
      const groups = new Map();
      for (const x of filtered) {
        const key = normalizeForGroup(x.u);
        if (!key) continue;
        const g = groups.get(key) || { key, list: [], score: 0 };
        g.list.push(x);
        groups.set(key, g);
      }

      const chapterLike = (x) => isChapterCandidateText(x.t);
      for (const g of groups.values()) {
        const n = g.list.length;
        const m = g.list.filter(chapterLike).length;
        g.score = n + m * 2;
      }

      const bestGroup = Array.from(groups.values()).sort((a, b) => b.score - a.score)[0];
      const picked = (bestGroup?.list ?? filtered)
        .filter((x) => x.u && x.t && x.t.length <= 80)
        .filter((x) => chapterLike(x) || (bestGroup ? true : false));

      const dedup = [];
      const seen = new Set();
      for (const x of picked) {
        if (seen.has(x.u)) continue;
        seen.add(x.u);
        dedup.push({ t: x.t, u: x.u });
        if (dedup.length >= 400) break;
      }

      const tocUrlCandidate = dedup.length ? '' : (isLikelyChapterText ? findTocLink() : '');

      const debug = {
        adapter: 'generic',
        rawUrl,
        host,
        anchorsTotal: Array.from(document.querySelectorAll('a[href]')).length,
        groups: groups.size,
        bestGroupScore: bestGroup?.score ?? 0,
        bestGroupCount: bestGroup?.list?.length ?? 0
      };
      return { detailUrl, bookTitle, introText, chapters: dedup, tocUrlCandidate, debug };
    })()`)) as any
  }

  // Try current page; if it's a chapter page without toc / 仅误识别到 1 章，则跟目录候选链再试一次。
  let res: any = await extractOnce()
  const normalizeHref = (u: string) => {
    try {
      const x = new URL(u)
      x.hash = ''
      return x.href
    } catch {
      return String(u || '').trim()
    }
  }
  let tocUrlCandidate = String(res?.tocUrlCandidate ?? '').trim()
  const ch0 = Array.isArray(res?.chapters) ? res.chapters : []
  const currentHref = normalizeHref(wc.getURL())
  const tocHref = tocUrlCandidate ? normalizeHref(tocUrlCandidate) : ''
  const shouldFollowToc =
    Boolean(tocUrlCandidate && isValidHttpUrl(tocUrlCandidate)) &&
    tocHref !== currentHref &&
    (ch0.length === 0 || ch0.length === 1)

  if (shouldFollowToc) {
    await loadUrlInWebWindow(tocUrlCandidate)
    await waitWebContentsReady(wc)
    res = await extractOnce()
  }

  let chaptersProbe = Array.isArray(res?.chapters) ? res.chapters : []
  if (chaptersProbe.length <= 1) {
    const backUrls = (await wc.executeJavaScript(
      `(() => {
        const abs = (href) => { try { return new URL(href, location.href).toString(); } catch { return ''; } };
        let origin = '';
        try { origin = new URL(location.href).origin; } catch { return []; }
        const keyRe = /(目录|书页|作品|详情|简介|返回|全部章节|章节目录)/i;
        const out = [];
        const seen = new Set();
        for (const a of document.querySelectorAll('a[href]')) {
          const t = (a.textContent || '').trim();
          const u = abs(a.getAttribute('href') || '');
          if (!u || !t || t.length > 72) continue;
          try {
            if (new URL(u).origin !== origin) continue;
          } catch {
            continue;
          }
          if (seen.has(u)) continue;
          if (keyRe.test(t) || /\\/(novel|book|ebook|work|works|shu)\\b/i.test(u) || /novelid|bookid|aid=/i.test(u)) {
            seen.add(u);
            out.push(u);
          }
        }
        return out.slice(0, 10);
      })()`,
      true
    )) as string[]

    let hops = 0
    for (const jump of backUrls || []) {
      if (hops >= 4) break
      const j = String(jump || '').trim()
      if (!isValidHttpUrl(j)) continue
      if (normalizeHref(j) === normalizeHref(wc.getURL())) continue
      hops += 1
      await loadUrlInWebWindow(j)
      await waitWebContentsReady(wc)
      res = await extractOnce()
      chaptersProbe = Array.isArray(res?.chapters) ? res.chapters : []
      if (chaptersProbe.length >= 2) break
    }
  }

  const detailUrl = String(res?.detailUrl ?? '')
  const bookTitle = sanitizeWebBookShelfTitle(String(res?.bookTitle ?? ''))
  const introText = String(res?.introText ?? '').trim()
  const chapters = Array.isArray(res?.chapters) ? res.chapters : []
  let domain: string | null = null
  try {
    if (detailUrl) domain = new URL(detailUrl).hostname || null
  } catch {
    domain = null
  }
  if (!detailUrl) throw webExtractErr('NO_URL', '未能获取书籍详情页 URL。')
  if (!chapters.length) {
    const dbg = res?.debug ? JSON.stringify(res.debug) : ''
    const msg = dbg ? `未识别到目录链接。debug=${dbg}` : '未识别到目录链接（可能不是详情页或站点结构特殊）。'
    throw webExtractErr('EMPTY_TOC', msg.slice(0, 1200))
  }
  const tocStatus = chapters.length >= 2 ? 'ready' : chapters.length === 1 ? 'partial' : 'missing'
  return { detailUrl, domain, bookTitle, introText, chapters, tocStatus }
})

ipcHandleTrusted('web:close', () => {
  if (!webWindow || webWindow.isDestroyed()) return { ok: true }
  webWindow.close()
  return { ok: true }
})

ipcHandleTrusted('overlay:getSession', () => {
  return getOverlaySession()
})

ipcHandleTrusted(
  'overlay:pushSession',
  (_evt, args: { bookId: string; itemId: string; lines: string[]; lineIndex?: number; playing?: boolean }) => {
    const lineIndex = Math.max(0, Number(args.lineIndex ?? 0))
    const playing = Boolean(args.playing ?? false)
    const session = { bookId: args.bookId, itemId: args.itemId, lines: args.lines, lineIndex, playing }
    setOverlaySession(session)
    overlayWindow?.show()
    broadcastOverlaySession(session)
    broadcastOverlayBounds()
    syncAuxPositions()
    return { ok: true }
  }
)

ipcHandleTrusted('overlay:clearWebNextCandidates', () => {
  const cur = getOverlaySession()
  if (!cur) return { ok: false }
  const next: OverlaySession = { ...cur, webNextCandidates: undefined }
  setOverlaySession(next)
  broadcastOverlaySession(next)
  return { ok: true }
})

ipcHandleTrusted('overlay:resume', async (_evt, args: { bookId: string; cols?: number }) => {
  let items: ReturnType<typeof getBook>['items']
  let progress: ReturnType<typeof getBook>['progress']
  try {
    ;({ items, progress } = getBook(args.bookId))
  } catch {
    setOverlaySession(null)
    broadcastOverlaySession(null)
    hideAuxWindows()
    return null
  }
  const nextItemId = progress?.itemId ?? items[0]?.id
  if (!nextItemId) throw new Error('NO_ITEM')
  const ensured = await ensureWebItemContentFromSource(nextItemId)
  const { item } = getItemContent(nextItemId)
  const lines = resolveOverlayLinesWithEnsure(item.contentText, ensured)
  const lineIndex = Math.max(0, progress?.lineIndex ?? 0)
  const session: OverlaySession = {
    bookId: args.bookId,
    itemId: nextItemId,
    lines,
    lineIndex,
    playing: false,
    ...mergeOverlayWebNextFromEnsure(ensured, item)
  }
  setOverlaySession(session)
  overlayWindow?.show()
  broadcastOverlaySession(session)
  broadcastOverlayBounds()
  syncAuxPositions()
  return session
})

function isLikelyFrontMatterTitle(title: string) {
  const t = String(title ?? '').trim().toLowerCase()
  if (!t) return false
  return /^(cover|table\s+of\s+contents|toc|目录|封面|扉页|版权|contents?)$/i.test(t)
}

function pickChapterOrdinalFromText(text: string): number | null {
  const s = String(text ?? '')
  const mEn = s.match(/chapter\s*([0-9]{1,5})/i)
  if (mEn) return Number(mEn[1])
  const mNum = s.match(/(?:^|\s)([0-9]{1,5})(?:\s*[.、:：\-]|\s|$)/)
  if (mNum) return Number(mNum[1])
  return null
}

function pickEpubChapterKey(item: { title: string; contentText: string }, idx: number) {
  const title = String(item?.title ?? '').trim()
  if (isLikelyFrontMatterTitle(title)) return `front:${title.toLowerCase()}`
  const ordFromTitle = pickChapterOrdinalFromText(title)
  if (ordFromTitle != null) return `ord:${ordFromTitle}`

  const firstLine = String(item?.contentText ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((x) => x.trim())
    .find(Boolean)
  const ordFromBody = pickChapterOrdinalFromText(firstLine ?? '')
  if (ordFromBody != null) return `ord:${ordFromBody}`

  return `idx:${idx}`
}

function resolveSteppedItemIndexForEpub(
  items: Array<{ title: string; contentText: string }>,
  curIdx: number,
  delta: number
) {
  const d = Math.trunc(Number(delta ?? 0))
  if (!Number.isFinite(d) || d === 0) return curIdx

  const keys = items.map((it, i) => pickEpubChapterKey(it, i))
  const groups: Array<{ key: string; indices: number[]; preferredIdx: number }> = []
  const itemToGroup: number[] = []

  for (let i = 0; i < items.length; i++) {
    const key = keys[i]
    const prev = groups[groups.length - 1]
    if (!prev || prev.key !== key) {
      groups.push({ key, indices: [i], preferredIdx: i })
      itemToGroup[i] = groups.length - 1
    } else {
      prev.indices.push(i)
      itemToGroup[i] = groups.length - 1
      const curBestLen = String(items[prev.preferredIdx]?.contentText ?? '').trim().length
      const nowLen = String(items[i]?.contentText ?? '').trim().length
      if (nowLen > curBestLen) prev.preferredIdx = i
    }
  }

  const curGroup = itemToGroup[curIdx] ?? 0
  const nextGroup = Math.max(0, Math.min(groups.length - 1, curGroup + d))
  const g = groups[nextGroup]
  if (!g) return curIdx
  return g.preferredIdx
}

ipcHandleTrusted('overlay:chapterStep', async (_evt, args: { delta: number }) => {
  const cur = getOverlaySession()
  if (!cur) return { ok: false }
  let items: ReturnType<typeof getBook>['items']
  try {
    ;({ items } = getBook(cur.bookId))
  } catch {
    setOverlaySession(null)
    broadcastOverlaySession(null)
    hideAuxWindows()
    return { ok: false, reason: 'BOOK_REMOVED' as const }
  }
  const idx = items.findIndex((x) => x.id === cur.itemId)
  if (idx < 0) return { ok: false }
  const d = Math.trunc(Number(args.delta ?? 0))
  const fromBook = getBook(cur.bookId)
  const useEpubSmartStep =
    fromBook.book.sourceType === 'file' && /\.epub$/i.test(String(fromBook.book.sourceRef ?? '').trim())

  const nextIdx = useEpubSmartStep
    ? resolveSteppedItemIndexForEpub(items, idx, d)
    : Math.max(0, Math.min(items.length - 1, idx + d))

  if (nextIdx === idx) return { ok: true, unchanged: true }
  const nextItemId = items[nextIdx]?.id
  if (!nextItemId) return { ok: false }
  const ensured = await ensureWebItemContentFromSource(nextItemId)
  const { item } = getItemContent(nextItemId)
  const lines = resolveOverlayLinesWithEnsure(item.contentText, ensured)
  // 章节切换时保留“当前是否自动阅读”的播放状态：
  // - 用户手动翻章时通常为暂停，结果仍保持暂停
  // - 自动阅读续章时需要继续播放
  const next: OverlaySession = {
    ...cur,
    itemId: nextItemId,
    lines,
    lineIndex: 0,
    playing: Boolean(cur.playing),
    ...mergeOverlayWebNextFromEnsure(ensured, item)
  }
  setOverlaySession(next)
  overlayWindow?.show()
  broadcastOverlaySession(next)
  broadcastOverlayBounds()
  syncAuxPositions()
  upsertProgress({ bookId: next.bookId, itemId: next.itemId, lineIndex: 0, updatedAt: Date.now() })
  return { ok: true, itemId: nextItemId }
})

ipcHandleTrusted('progress:set', (_evt, args: { bookId: string; itemId: string; lineIndex: number }) => {
  const updatedAt = Date.now()
  upsertProgress({ bookId: args.bookId, itemId: args.itemId, lineIndex: Math.max(0, Math.floor(args.lineIndex)), updatedAt })
  return { ok: true }
})

ipcHandleTrusted('overlay:setPlaying', (_evt, args: { playing: boolean }) => {
  const cur = getOverlaySession()
  if (!cur) return { ok: false }
  const next = { ...cur, playing: Boolean(args.playing) }
  setOverlaySession(next)
  broadcastOverlaySession(next)
  return { ok: true }
})

ipcHandleTrusted('overlay:syncLineIndex', (_evt, args: { lineIndex: number }) => {
  const cur = getOverlaySession()
  if (!cur) return { ok: false }
  const lineIndex = Math.max(0, Math.floor(Number(args?.lineIndex ?? 0)))
  // 只更新主进程里的 session，不广播：避免渲染进程在播放时被反向覆盖/抖动
  if (cur.lineIndex === lineIndex) return { ok: true, unchanged: true }
  setOverlaySession({ ...cur, lineIndex })
  return { ok: true }
})

ipcHandleTrusted('overlay:forceRepaint', () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return { ok: false }
  for (const t of overlayRepaintPulseTimers) clearTimeout(t)
  overlayRepaintPulseTimers = []

  const pulse = () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    try {
      // macOS：透明无边框窗口的“残影”常与系统阴影层陈旧有关（Apple 侧合成问题），
      // Electron 官方建议用 invalidateShadow 清掉陈旧阴影/残影，比反复 nudge 更接近根因。
      // 参见 electron#47693 / PR#32452。
      if (process.platform === 'darwin') overlayWindow.invalidateShadow()
    } catch {
      // ignore
    }
    try {
      // Electron/Chromium 在透明窗口下偶发“合成残影”，invalidate 能强制重新取帧。
      overlayWindow.webContents.invalidate()
    } catch {
      // ignore
    }
    try {
      // 某些合成路径下 same-bounds 可能被优化掉：做一次“1 像素往返”强制合成刷新。
      const b = overlayWindow.getBounds()
      const wa = screen.getDisplayMatching(b).workArea
      const canNudgeDown = b.y + b.height + 1 <= wa.y + wa.height
      const y1 = canNudgeDown ? b.y + 1 : Math.max(wa.y, b.y - 1)
      overlayWindow.setBounds({ ...b, y: y1 }, false)
      overlayWindow.setBounds({ ...b }, false)
    } catch {
      // ignore
    }
    try {
      // 透明窗口在 macOS 上偶发需要一次轻微 opacity nudge 才会立即清掉旧帧。
      if (process.platform === 'darwin' && overlayWindow.isVisible()) {
        overlayWindow.setOpacity(0.999)
        overlayWindow.setOpacity(1)
      }
    } catch {
      // ignore
    }
  }

  // 短脉冲：当前 + 后续两帧，覆盖“翻页后 1~2 帧才更新合成层”的场景。
  pulse()
  overlayRepaintPulseTimers.push(setTimeout(pulse, 18), setTimeout(pulse, 54))
  return { ok: true }
})

ipcHandleTrusted('overlay:hide', () => {
  const mainWasVisible = Boolean(mainWindow?.isVisible?.())
  const cur = getOverlaySession()
  if (cur) {
    const next = { ...cur, playing: false }
    setOverlaySession(next)
    broadcastOverlaySession(next)
  }
  overlayWindow?.hide()
  hideAuxWindows()
  // macOS 上隐藏当前激活窗口后，系统可能会把同一 App 的另一个窗口（main）顶到前台。
  // 若 main 本来就没显示，则直接把整个 App 隐藏掉，避免“关闭阅读条却弹出主窗口”。
  if (process.platform === 'darwin' && !mainWasVisible) {
    try {
      app.hide()
    } catch {
      /* ignore */
    }
  }
  return { ok: true }
})

ipcHandleTrusted('overlay:auxHideAll', () => {
  hideAuxWindows()
  return { ok: true }
})

ipcHandleTrusted('overlay:auxHideAllSmart', () => {
  // 当 overlay 失焦是因为用户点击了“设置窗内部控件”时，不要把设置窗立刻隐藏。
  // 但工具栏始终可以收起，避免遮挡。
  const focused = BrowserWindow.getFocusedWindow()
  const focusedIsSettings = Boolean(
    focused &&
      overlaySettingsWindow &&
      !overlaySettingsWindow.isDestroyed() &&
      focused.id === overlaySettingsWindow.id
  )
  overlayToolbarWindow?.hide()
  if (!focusedIsSettings) overlaySettingsWindow?.hide()
  return { ok: true, keptSettings: focusedIsSettings }
})

ipcHandleTrusted('overlay:toolbarToggle', () => {
  const w = ensureOverlayToolbarWindow()
  if (!overlayWindow?.isVisible()) overlayWindow?.show()
  if (w.isVisible()) w.hide()
  else {
    positionOverlayToolbar()
    // 不抢焦点，减少触发 overlay blur 的概率
    w.showInactive()
  }
  return { ok: true, visible: w.isVisible() }
})

ipcHandleTrusted('overlay:settingsToggle', () => {
  const w = ensureOverlaySettingsWindow()
  if (!overlayWindow?.isVisible()) overlayWindow?.show()
  if (w.isVisible()) w.hide()
  else {
    // 打开设置时收起工具栏，避免贴顶场景下两者叠在同一侧互相遮挡
    overlayToolbarWindow?.hide()
    layoutOverlaySettings()
    w.show()
  }
  return { ok: true, visible: w.isVisible() }
})

ipcHandleTrusted('overlay:toolbarShow', () => {
  const w = ensureOverlayToolbarWindow()
  if (!overlayWindow?.isVisible()) overlayWindow?.show()
  positionOverlayToolbar()
  // 不抢焦点，减少触发 overlay blur 的概率
  w.showInactive()
  return { ok: true }
})

ipcHandleTrusted('overlay:toolbarHide', () => {
  overlayToolbarWindow?.hide()
  return { ok: true }
})

ipcHandleTrusted('overlay:settingsShow', () => {
  const w = ensureOverlaySettingsWindow()
  if (!overlayWindow?.isVisible()) overlayWindow?.show()
  // 打开设置时收起工具栏，避免贴顶场景下两者叠在同一侧互相遮挡
  overlayToolbarWindow?.hide()
  layoutOverlaySettings()
  // 不强制抢焦点，避免与 Overlay/工具栏的焦点切换产生闪烁
  w.showInactive()
  return { ok: true }
})

ipcHandleTrusted('overlay:settingsHide', () => {
  overlaySettingsWindow?.hide()
  return { ok: true }
})

ipcHandleTrusted('overlay:settingsResize', (_evt, args: { width?: number; height?: number }) => {
  return resizeOverlaySettings(args || {})
})

ipcHandleTrusted('overlay:getBounds', () => {
  if (!overlayWindow) return null
  return overlayWindow.getBounds()
})

ipcHandleTrusted('overlay:step', (_evt, args: { delta: number }) => {
  const cur = getOverlaySession()
  if (!cur) return { ok: false }
  const d = Number(args.delta ?? 0)
  const nextIdx = Math.max(0, Math.min(cur.lines.length - 1, cur.lineIndex + d))
  const next = { ...cur, lineIndex: nextIdx }
  setOverlaySession(next)
  broadcastOverlaySession(next)
  upsertProgress({ bookId: next.bookId, itemId: next.itemId, lineIndex: next.lineIndex, updatedAt: Date.now() })
  return { ok: true, lineIndex: nextIdx }
})

ipcHandleTrusted('overlay:stepDisplay', (_evt, args: { delta: number }) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return { ok: false }
  const delta = Math.trunc(Number(args?.delta ?? 0))
  overlayWindow.webContents.send('overlay:stepDisplay', { delta })
  return { ok: true }
})

ipcHandleTrusted('overlay:kModeSet', (_evt, args: { enabled: boolean }) => {
  const enabled = Boolean(args?.enabled)
  broadcastOverlayKMode(enabled)
  return { ok: true, enabled }
})

ipcHandleTrusted('overlay:setBounds', (_evt, args: { x?: number; y?: number; width?: number; height?: number }) => {
  if (!overlayWindow) return { ok: false }
  const b = overlayWindow.getBounds()
  const x = typeof args.x === 'number' ? Math.floor(args.x) : b.x
  const y = typeof args.y === 'number' ? Math.floor(args.y) : b.y
  const width = typeof args.width === 'number' ? Math.max(220, Math.floor(args.width)) : b.width
  const height = typeof args.height === 'number' ? Math.max(40, Math.floor(args.height)) : b.height
  // 拖拽/缩放时禁用动画，否则会出现闪动与跟手差
  overlayWindow.setBounds({ ...b, x, y, width, height }, false)
  scheduleSaveOverlayBounds()
  return { ok: true }
})

ipcOnTrusted('overlay:setBoundsFast', (_evt, args: { x?: number; y?: number; width?: number; height?: number }) => {
  if (!overlayWindow) return
  const b = overlayWindow.getBounds()
  const x = typeof args.x === 'number' ? Math.floor(args.x) : b.x
  const y = typeof args.y === 'number' ? Math.floor(args.y) : b.y
  const width = typeof args.width === 'number' ? Math.max(220, Math.floor(args.width)) : b.width
  const height = typeof args.height === 'number' ? Math.max(40, Math.floor(args.height)) : b.height
  overlayWindow.setBounds({ ...b, x, y, width, height }, false)
  scheduleSaveOverlayBounds()
})

ipcOnTrusted('overlay:moveStart', () => {
  startOverlayMove()
})

ipcOnTrusted('overlay:moveStop', () => {
  stopOverlayMove()
  scheduleSaveOverlayBounds()
})

ipcHandleTrusted('overlay:locate', () => locateOverlayBar())

ipcHandleTrusted('overlay:restoreLast', async (_evt, args: { cols?: number }) => {
  const last = getLastProgress()
  if (!last) return null
  try {
    const ensured = await ensureWebItemContentFromSource(last.itemId)
    const { item } = getItemContent(last.itemId)
    const lines = resolveOverlayLinesWithEnsure(item.contentText, ensured)
    const lineIndex = Math.min(last.lineIndex, Math.max(0, lines.length - 1))
    const session: OverlaySession = {
      bookId: last.bookId,
      itemId: last.itemId,
      lines,
      lineIndex,
      playing: false,
      ...mergeOverlayWebNextFromEnsure(ensured, item)
    }
    setOverlaySession(session)
    overlayWindow?.show()
    broadcastOverlaySession(session)
    broadcastOverlayBounds()
    return session
  } catch {
    return null
  }
})

