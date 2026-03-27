import { BrowserWindow, app, globalShortcut, ipcMain, screen } from 'electron'
import path from 'node:path'
import {
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
  listGroups,
  moveBooks,
  renameBook,
  renameGroup,
  setOverlaySession,
  updateItemContent,
  upsertProgress
} from './db'
import { WebContentExtractor } from './webContentExtractor'

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let overlayToolbarWindow: BrowserWindow | null = null
let overlaySettingsWindow: BrowserWindow | null = null
let overlayMoveTimer: NodeJS.Timeout | null = null
let overlayMoveState: null | { winStart: { x: number; y: number }; mouseStart: { x: number; y: number } } = null
let auxSyncTimer: NodeJS.Timeout | null = null
let auxSyncPending = false

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

function getIndexFileUrl() {
  const indexPath = path.join(app.getAppPath(), 'dist', 'index.html')
  return `file://${indexPath}`
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist-electron', 'preload.js'),
      contextIsolation: true
    }
  })

  if (process.env.ELECTRON_DEV) {
    mainWindow.loadURL(`${getDevUrl()}/#/`)
    // 开发时默认把 DevTools 停靠在窗口内，避免额外弹出一个独立窗口
    mainWindow.webContents.openDevTools({ mode: 'right' })
  } else {
    mainWindow.loadURL(`${getIndexFileUrl()}#/`)
  }
}

function createOverlayWindow() {
  const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize
  const defaultW = Math.min(760, Math.max(420, Math.floor(screenWidth * 0.62)))
  overlayWindow = new BrowserWindow({
    x: Math.max(0, Math.floor((screenWidth - defaultW) / 2)),
    y: 0,
    width: defaultW,
    height: 56,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist-electron', 'preload.js'),
      contextIsolation: true
    }
  })

  if (process.env.ELECTRON_DEV) {
    overlayWindow.loadURL(`${getDevUrl()}/#/overlay`)
  } else {
    overlayWindow.loadURL(`${getIndexFileUrl()}#/overlay`)
  }
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
      preload: path.join(app.getAppPath(), 'dist-electron', 'preload.js'),
      contextIsolation: true
    }
  })
  if (process.env.ELECTRON_DEV) overlayToolbarWindow.loadURL(`${getDevUrl()}/#/overlay-toolbar`)
  else overlayToolbarWindow.loadURL(`${getIndexFileUrl()}#/overlay-toolbar`)
  overlayToolbarWindow.on('closed', () => {
    overlayToolbarWindow = null
  })
  return overlayToolbarWindow
}

function ensureOverlaySettingsWindow() {
  if (overlaySettingsWindow && !overlaySettingsWindow.isDestroyed()) return overlaySettingsWindow
  overlaySettingsWindow = new BrowserWindow({
    width: 420,
    height: 520,
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
      preload: path.join(app.getAppPath(), 'dist-electron', 'preload.js'),
      contextIsolation: true
    }
  })
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
  return overlaySettingsWindow
}

function clampToWorkArea(bounds: { x: number; y: number; width: number; height: number }) {
  const display = screen.getDisplayMatching(bounds)
  const wa = display.workArea
  const x = clamp(bounds.x, wa.x, wa.x + wa.width - bounds.width)
  const y = clamp(bounds.y, wa.y, wa.y + wa.height - bounds.height)
  return { ...bounds, x, y }
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

function positionOverlaySettings() {
  if (!overlayWindow || !overlaySettingsWindow) return
  const ob = overlayWindow.getBounds()
  const sb = overlaySettingsWindow.getBounds()
  const margin = 10
  const gap = 10
  const display = screen.getDisplayMatching(ob)
  const wa = display.workArea

  const preferBelow = Math.round(ob.y + ob.height + gap)
  const preferAbove = Math.round(ob.y - sb.height - gap)
  const fitsBelow = preferBelow + sb.height <= wa.y + wa.height
  const fitsAbove = preferAbove >= wa.y

  let x = Math.round(ob.x + ob.width - sb.width - margin)
  let y = fitsBelow ? preferBelow : fitsAbove ? preferAbove : clamp(Math.round(ob.y + ob.height + gap), wa.y, wa.y + wa.height - sb.height)

  overlaySettingsWindow.setBounds(clampToWorkArea({ x, y, width: sb.width, height: sb.height }), false)
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
}

function broadcastOverlayBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  const b = overlayWindow.getBounds()
  overlayWindow.webContents.send('overlay:bounds', b)
  overlayToolbarWindow?.webContents.send('overlay:bounds', b)
  overlaySettingsWindow?.webContents.send('overlay:bounds', b)
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+X', () => {
    if (!overlayWindow) return
    if (overlayWindow.isVisible()) overlayWindow.hide()
    else overlayWindow.show()
  })
}

app.whenReady().then(() => {
  createMainWindow()
  createOverlayWindow()
  registerShortcuts()

  overlayWindow?.on('move', requestSyncAuxPositions)
  overlayWindow?.on('resize', () => {
    requestSyncAuxPositions()
  })
  overlayWindow?.on('moved', syncAuxPositions)
  overlayWindow?.on('resized', syncAuxPositions)
  overlayWindow?.on('show', () => {
    syncAuxPositions()
    broadcastOverlayBounds()
  })
  // Overlay 失焦时的收起逻辑已统一交给渲染进程（OverlayView）通过 IPC `overlay:auxHideAll` 控制，
  // 这里不再在主进程上监听 blur 直接隐藏，避免与设置窗/工具栏显示产生竞态。
  overlayWindow?.on('hide', () => {
    stopOverlayMove()
    hideAuxWindows()
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
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

ipcMain.handle('overlay:setConfig', (_evt, cfg: { opacity?: number }) => {
  if (!overlayWindow) return
  if (typeof cfg.opacity === 'number') overlayWindow.setOpacity(cfg.opacity)
})

ipcMain.handle('library:listBooks', () => {
  return { books: listBooks() }
})

ipcMain.handle('library:getBook', (_evt, args: { bookId: string }) => {
  return getBook(args.bookId)
})

ipcMain.handle(
  'library:importTxt',
  (_evt, args: { title: string; sourceRef: string; items: Array<{ title: string; contentText: string }> }) => {
    return importTxtBook(args)
  }
)

ipcMain.handle('library:renameBook', (_evt, args: { bookId: string; title: string }) => {
  return renameBook(args.bookId, args.title)
})

ipcMain.handle('library:listGroups', () => {
  return { groups: listGroups() }
})

ipcMain.handle('library:createGroup', (_evt, args: { title: string; parentId?: string | null }) => {
  const title = String(args?.title ?? '').trim()
  if (!title) throw new Error('INVALID_TITLE')
  return createGroup({ title, parentId: args?.parentId ?? null })
})

ipcMain.handle('library:renameGroup', (_evt, args: { groupId: string; title: string }) => {
  const groupId = String(args?.groupId ?? '')
  const title = String(args?.title ?? '').trim()
  if (!groupId) throw new Error('INVALID_GROUP')
  if (!title) throw new Error('INVALID_TITLE')
  return renameGroup(groupId, title)
})

ipcMain.handle('library:deleteGroup', (_evt, args: { groupId: string; mode: 'keepBooks' | 'deleteBooks' }) => {
  const groupId = String(args?.groupId ?? '')
  const mode = args?.mode === 'deleteBooks' ? 'deleteBooks' : 'keepBooks'
  if (!groupId) throw new Error('INVALID_GROUP')
  return deleteGroup({ groupId, mode })
})

ipcMain.handle('library:moveBooks', (_evt, args: { bookIds: string[]; groupId: string | null }) => {
  const bookIds = Array.isArray(args?.bookIds) ? args.bookIds.map(String).filter(Boolean) : []
  const groupId = args?.groupId ? String(args.groupId) : null
  return moveBooks({ bookIds, groupId })
})

ipcMain.handle('library:deleteBooks', (_evt, args: { bookIds: string[] }) => {
  const bookIds = Array.isArray(args?.bookIds) ? args.bookIds.map(String).filter(Boolean) : []
  return deleteBooks({ bookIds })
})

ipcMain.handle(
  'library:importWebItem',
  (_evt, args: { title: string; sourceUrl: string; contentText: string; domain: string | null; bookId?: string | null }) => {
    if (!args?.contentText || !String(args.contentText).trim()) throw new Error('EMPTY_CONTENT')
    return importWebItem(args)
  }
)

ipcMain.handle(
  'library:importWebBook',
  (
    _evt,
    args: { bookTitle: string; detailUrl: string; domain: string | null; introText?: string | null; chapters: Array<{ title: string; url: string }> }
  ) => {
    const detailUrl = String(args?.detailUrl ?? '').trim()
    if (!/^https?:\/\//i.test(detailUrl)) throw new Error('INVALID_URL')
    const bookTitle = String(args?.bookTitle ?? '').trim() || '未命名网页'
    const chapters = Array.isArray(args?.chapters) ? args.chapters : []
    if (chapters.length === 0) throw new Error('EMPTY_TOC')
    return importWebBook({ bookTitle, detailUrl, domain: args?.domain ?? null, introText: args?.introText ?? null, chapters })
  }
)

ipcMain.handle('library:updateItemContent', (_evt, args: { itemId: string; contentText: string }) => {
  return updateItemContent({ itemId: String(args?.itemId ?? ''), contentText: String(args?.contentText ?? '') })
})

let webWindow: BrowserWindow | null = null

function ensureWebWindow() {
  if (webWindow && !webWindow.isDestroyed()) return webWindow
  webWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist-electron', 'preload.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  webWindow.on('closed', () => {
    webWindow = null
  })
  return webWindow
}

ipcMain.handle('web:open', async (_evt, args: { url: string }) => {
  if (!args?.url) throw new Error('INVALID_URL')
  const w = ensureWebWindow()
  const url = String(args.url).trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('INVALID_URL')
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

ipcMain.handle('web:extract', async () => {
  if (!webWindow || webWindow.isDestroyed()) {
    throw webExtractErr('NO_WEB_WINDOW', '未检测到已打开的网页窗口，请先点击“打开网页”。')
  }
  const wc = webWindow.webContents
  try {
    await waitWebContentsReady(wc)
  } catch (e) {
    if (isWebExtractLoadTimeout(e)) {
      console.info('[web:extract] waitWebContentsReady LOAD_TIMEOUT, continuing DOM extract', wc.getURL())
    } else {
      throw e
    }
  }

  // 触发一次懒加载（常见于“滚动后才填充正文/图片占位”页面）
  try {
    await wc.executeJavaScript(`(() => new Promise((resolve) => {
      const maxSteps = 6;
      let step = 0;
      const tick = () => {
        step += 1;
        window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
        if (step >= maxSteps) {
          setTimeout(() => {
            window.scrollTo(0, 0);
            resolve(true);
          }, 250);
          return;
        }
        setTimeout(tick, 180);
      };
      tick();
    }))()`)
  } catch {
    // ignore
  }

  const res = await wc.executeJavaScript(`(() => {
    const url = location.href || '';
    const title = document.title || '';
    const readyState = document.readyState || '';

    const pickRoot = () => {
      const selectors = ['article', 'main', '#content', '.content', '.article', '.post', '.entry', '.entry-content'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent && el.textContent.trim().length > 200) return el;
      }
      return document.body;
    };

    const root = pickRoot();
    if (!root) return { url, title, readyState, contentText: '' };

    const clone = root.cloneNode(true);
    const removeSelectors = [
      'nav','footer','aside','script','style','noscript',
      'header','form','input','button','select','textarea',
      '[role="navigation"]','[role="complementary"]'
    ];
    for (const sel of removeSelectors) {
      clone.querySelectorAll(sel).forEach((n) => n.remove());
    }

    const text = (clone.textContent || '').replace(/\\r\\n/g, '\\n');
    return { url, title, readyState, contentText: text };
  })()`)

  const url = String(res?.url ?? '')
  const title = String(res?.title ?? '')
  const contentText = String(res?.contentText ?? '').trim()
  const readyState = String(res?.readyState ?? '')
  const preview80 = contentText.slice(0, 80)
  console.info(
    '[web:extract]',
    'url=',
    wc.getURL(),
    'readyState=',
    readyState,
    'len=',
    contentText.length,
    'preview=',
    preview80
  )

  let domain: string | null = null
  try {
    if (url) domain = new URL(url).hostname || null
  } catch {
    domain = null
  }

  // 更明确的失败原因（用于 UI 提示）
  if (!url) {
    throw webExtractErr('NO_URL', '未能获取当前页面 URL（可能页面尚未完成加载）。')
  }
  if (!contentText) {
    const hint = /登录|注册|sign\\s*in|log\\s*in|验证码|请先|购买|订阅|会员|充值/i.test(title)
      ? '（疑似需要登录/购买/订阅，完成操作后再提取）'
      : ''
    throw webExtractErr('EMPTY_CONTENT', `未检测到正文内容${hint}。`)
  }
  if (contentText.length < 200) {
    // 对动态渲染/反爬常见空壳页面给出提示
    const maybeDynamic = readyState !== 'complete'
    const hint = maybeDynamic ? '（页面可能仍在动态加载，稍等或向下滚动后再试）' : '（可能打开的不是正文页，或站点做了反爬/动态渲染）'
    throw webExtractErr('TOO_SHORT', `正文过短，无法导入${hint}。`)
  }

  const previewLines = contentText.split('\n').map((s) => s.trim()).filter(Boolean)
  const preview = previewLines.slice(0, 12).join('\n')

  return {
    title,
    url,
    domain,
    contentText,
    preview,
    extractor: 'dom-text'
  }
})

async function loadUrlInWebWindow(url: string) {
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

ipcMain.handle('web:extractAtUrl', async (_evt, args: { url: string }) => {
  const url = String(args?.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) throw webExtractErr('INVALID_URL', '无效 URL。')
  const w = await loadUrlInWebWindow(url)
  w.show()
  // reuse existing extract logic by calling the handler logic inline (duplicated minimal)
  const wc = w.webContents
  await waitWebContentsReady(wc)
  const res = await wc.executeJavaScript(`(() => {
    const url = location.href || '';
    const title = document.title || '';
    const readyState = document.readyState || '';
    const pickRoot = () => {
      const selectors = ['article', 'main', '#content', '.content', '.article', '.post', '.entry', '.entry-content'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent && el.textContent.trim().length > 200) return el;
      }
      return document.body;
    };
    const root = pickRoot();
    if (!root) return { url, title, readyState, contentText: '' };
    const clone = root.cloneNode(true);
    const removeSelectors = ['nav','footer','aside','script','style','noscript','header','form','input','button','select','textarea','[role=\"navigation\"]','[role=\"complementary\"]'];
    for (const sel of removeSelectors) clone.querySelectorAll(sel).forEach((n) => n.remove());
    const text = (clone.textContent || '').replace(/\\r\\n/g, '\\n');
    return { url, title, readyState, contentText: text };
  })()`)

  const pageUrl = String(res?.url ?? '')
  const title = String(res?.title ?? '')
  const contentText = String(res?.contentText ?? '').trim()
  const readyState = String(res?.readyState ?? '')
  let domain: string | null = null
  try {
    if (pageUrl) domain = new URL(pageUrl).hostname || null
  } catch {
    domain = null
  }
  if (!pageUrl) throw webExtractErr('NO_URL', '未能获取当前页面 URL。')
  if (!contentText) throw webExtractErr('EMPTY_CONTENT', '未检测到正文内容。')
  if (contentText.length < 200) {
    const maybeDynamic = readyState !== 'complete'
    const hint = maybeDynamic ? '（页面可能仍在动态加载，稍等或向下滚动后再试）' : '（可能打开的不是正文页，或站点做了反爬/动态渲染）'
    throw webExtractErr('TOO_SHORT', `正文过短，无法导入${hint}。`)
  }
  const previewLines = contentText.split('\\n').map((s: string) => s.trim()).filter(Boolean)
  const preview = previewLines.slice(0, 12).join('\\n')
  return { title, url: pageUrl, domain, contentText, preview, extractor: 'dom-text' }
})


ipcMain.handle('web:extractStructuredAtUrl', async (_evt, args: { url: string }) => {
  const url = String(args?.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) throw webExtractErr('INVALID_URL', '无效 URL。')

  const w = await loadUrlInWebWindow(url)
  w.show()
  const wc = w.webContents
  await waitWebContentsReady(wc)

  try {
    await wc.executeJavaScript(`(() => new Promise((resolve) => {
      let step = 0;
      const max = 6;
      const tick = () => {
        step += 1;
        window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
        if (step >= max) {
          setTimeout(() => {
            window.scrollTo(0, 0);
            resolve(true);
          }, 200);
          return;
        }
        setTimeout(tick, 180);
      };
      tick();
    }))()`, true)
  } catch {
    // ignore
  }

  const page = (await wc.executeJavaScript(
    `({ url: location.href || '', html: document.documentElement.outerHTML || '', title: document.title || '' })`,
    true
  )) as { url: string; html: string; title: string }

  const extractor = new WebContentExtractor({ minTextLength: 200 })
  const extracted = extractor.extractCurrentPage(page.url || url, page.html || '')
  const nav = extractor.detectNavigation(page.html || '', page.url || url)
  const toc = extractor.detectTOC(page.url || url, page.html || '')

  if (!extracted.textContent || extracted.length < 120) {
    throw webExtractErr('NO_MAIN_CONTENT', '正文提取失败或正文过短。')
  }

  return {
    url: page.url || url,
    title: extracted.title || page.title || '未命名网页',
    content: {
      title: extracted.title || page.title || '未命名网页',
      content: extracted.content,
      textContent: extracted.textContent,
      excerpt: extracted.textContent.slice(0, 180),
      author: undefined,
      publishedDate: undefined,
      wordCount: extracted.length
    },
    chapters: toc.entries || [],
    nextChapterUrl: nav.nextUrl,
    prevChapterUrl: nav.prevUrl,
    tocUrlCandidate: toc.tocUrlCandidate,
    isTocPage: toc.isTocPage,
    extractor: 'readability'
  }
})

ipcMain.handle('web:extractBookDetail', async () => {
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
        const h1 = (document.querySelector('h1')?.textContent || '').trim();
        if (h1) return h1;
        const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
        if (og.trim()) return og.trim();
        const t = (document.title || '').trim();
        if (!t) return '';
        return t.replace(/_.*$/, '').replace(/\\|.*$/, '').trim();
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
              return { t, u: url };
            })
          const aList = allAnchors.filter((x) => {
              if (!x.u || !x.t || x.t.length > 80) return false;
              const uu = parseUrl(x.u);
              if (!uu) return false;
              // accept both http/https as long as host/path matches
              return uu.hostname === baseHost && uu.pathname === basePath;
            });

          const chaptersRaw = aList
            .map((x) => {
              const uu = parseUrl(x.u);
              if (!uu) return null;
              if (!/\\/onebook\\.php$/i.test(uu.pathname)) return null;
              const nid2 = uu.searchParams.get('novelid') || '';
              const cid = uu.searchParams.get('chapterid') || '';
              if (!nid2 || nid2 !== nid) return null;
              if (!cid) return null;
              const nCid = Number(cid);
              if (!Number.isFinite(nCid) || nCid <= 0) return null;
              return {
                t: x.t,
                u: baseOrigin + uu.pathname + '?novelid=' + encodeURIComponent(nid) + '&chapterid=' + encodeURIComponent(String(nCid)),
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
            anchorsMatchedHostPath: aList.length,
            sampleChapterLinks: allAnchors
              .filter((x) => /chapterid=\\d+/i.test(x.u))
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

  // Try current page; if it's a chapter page without toc, auto-jump to toc and retry once.
  let res: any = await extractOnce()
  const tocUrlCandidate = String(res?.tocUrlCandidate ?? '').trim()
  if ((!Array.isArray(res?.chapters) || res.chapters.length === 0) && tocUrlCandidate && /^https?:\/\//i.test(tocUrlCandidate)) {
    await loadUrlInWebWindow(tocUrlCandidate)
    await waitWebContentsReady(wc)
    res = await extractOnce()
  }

  const detailUrl = String(res?.detailUrl ?? '')
  const bookTitle = String(res?.bookTitle ?? '').trim()
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
  return { detailUrl, domain, bookTitle, introText, chapters }
})

ipcMain.handle('web:close', () => {
  if (!webWindow || webWindow.isDestroyed()) return { ok: true }
  webWindow.close()
  return { ok: true }
})

ipcMain.handle('overlay:getSession', () => {
  return getOverlaySession()
})

ipcMain.handle(
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

ipcMain.handle('overlay:resume', (_evt, args: { bookId: string; cols?: number }) => {
  const { items, progress } = getBook(args.bookId)
  const nextItemId = progress?.itemId ?? items[0]?.id
  if (!nextItemId) throw new Error('NO_ITEM')
  const { item } = getItemContent(nextItemId)
  const lines = toRawLines(item.contentText)
  const lineIndex = Math.max(0, progress?.lineIndex ?? 0)
  const session = { bookId: args.bookId, itemId: nextItemId, lines, lineIndex, playing: false }
  setOverlaySession(session)
  overlayWindow?.show()
  broadcastOverlaySession(session)
  broadcastOverlayBounds()
  syncAuxPositions()
  return session
})

ipcMain.handle('overlay:chapterStep', (_evt, args: { delta: number }) => {
  const cur = getOverlaySession()
  if (!cur) return { ok: false }
  const { items } = getBook(cur.bookId)
  const idx = items.findIndex((x) => x.id === cur.itemId)
  if (idx < 0) return { ok: false }
  const d = Math.trunc(Number(args.delta ?? 0))
  const nextIdx = Math.max(0, Math.min(items.length - 1, idx + d))
  if (nextIdx === idx) return { ok: true, unchanged: true }
  const nextItemId = items[nextIdx]?.id
  if (!nextItemId) return { ok: false }
  const { item } = getItemContent(nextItemId)
  const lines = toRawLines(item.contentText)
  // 章节切换时保留“当前是否自动阅读”的播放状态：
  // - 用户手动翻章时通常为暂停，结果仍保持暂停
  // - 自动阅读续章时需要继续播放
  const next = { ...cur, itemId: nextItemId, lines, lineIndex: 0, playing: Boolean(cur.playing) }
  setOverlaySession(next)
  overlayWindow?.show()
  broadcastOverlaySession(next)
  broadcastOverlayBounds()
  syncAuxPositions()
  upsertProgress({ bookId: next.bookId, itemId: next.itemId, lineIndex: 0, updatedAt: Date.now() })
  return { ok: true, itemId: nextItemId }
})

ipcMain.handle('progress:set', (_evt, args: { bookId: string; itemId: string; lineIndex: number }) => {
  const updatedAt = Date.now()
  upsertProgress({ bookId: args.bookId, itemId: args.itemId, lineIndex: Math.max(0, Math.floor(args.lineIndex)), updatedAt })
  return { ok: true }
})

ipcMain.handle('overlay:setPlaying', (_evt, args: { playing: boolean }) => {
  const cur = getOverlaySession()
  if (!cur) return { ok: false }
  const next = { ...cur, playing: Boolean(args.playing) }
  setOverlaySession(next)
  broadcastOverlaySession(next)
  return { ok: true }
})

ipcMain.handle('overlay:syncLineIndex', (_evt, args: { lineIndex: number }) => {
  const cur = getOverlaySession()
  if (!cur) return { ok: false }
  const lineIndex = Math.max(0, Math.floor(Number(args?.lineIndex ?? 0)))
  // 只更新主进程里的 session，不广播：避免渲染进程在播放时被反向覆盖/抖动
  if (cur.lineIndex === lineIndex) return { ok: true, unchanged: true }
  setOverlaySession({ ...cur, lineIndex })
  return { ok: true }
})

ipcMain.handle('overlay:forceRepaint', () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return { ok: false }
  try {
    // Electron/Chromium 在透明窗口下偶发“合成残影”，invalidate 能强制重新取帧。
    overlayWindow.webContents.invalidate()
  } catch {
    // ignore
  }
  try {
    // 某些合成路径下 invalidate 不够“硬”，再用一次 same-bounds 刷新（不改变大小/位置）
    const b = overlayWindow.getBounds()
    overlayWindow.setBounds({ ...b }, false)
  } catch {
    // ignore
  }
  return { ok: true }
})

ipcMain.handle('overlay:hide', () => {
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

ipcMain.handle('overlay:auxHideAll', () => {
  hideAuxWindows()
  return { ok: true }
})

ipcMain.handle('overlay:auxHideAllSmart', () => {
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

ipcMain.handle('overlay:toolbarToggle', () => {
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

ipcMain.handle('overlay:settingsToggle', () => {
  const w = ensureOverlaySettingsWindow()
  if (!overlayWindow?.isVisible()) overlayWindow?.show()
  if (w.isVisible()) w.hide()
  else {
    positionOverlaySettings()
    w.show()
  }
  return { ok: true, visible: w.isVisible() }
})

ipcMain.handle('overlay:toolbarShow', () => {
  const w = ensureOverlayToolbarWindow()
  if (!overlayWindow?.isVisible()) overlayWindow?.show()
  positionOverlayToolbar()
  // 不抢焦点，减少触发 overlay blur 的概率
  w.showInactive()
  return { ok: true }
})

ipcMain.handle('overlay:toolbarHide', () => {
  overlayToolbarWindow?.hide()
  return { ok: true }
})

ipcMain.handle('overlay:settingsShow', () => {
  const w = ensureOverlaySettingsWindow()
  if (!overlayWindow?.isVisible()) overlayWindow?.show()
  positionOverlaySettings()
  // 不强制抢焦点，避免与 Overlay/工具栏的焦点切换产生闪烁
  w.showInactive()
  return { ok: true }
})

ipcMain.handle('overlay:settingsHide', () => {
  overlaySettingsWindow?.hide()
  return { ok: true }
})

ipcMain.handle('overlay:getBounds', () => {
  if (!overlayWindow) return null
  return overlayWindow.getBounds()
})

ipcMain.handle('overlay:step', (_evt, args: { delta: number }) => {
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

ipcMain.handle('overlay:stepDisplay', (_evt, args: { delta: number }) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return { ok: false }
  const delta = Math.trunc(Number(args?.delta ?? 0))
  overlayWindow.webContents.send('overlay:stepDisplay', { delta })
  return { ok: true }
})

ipcMain.handle('overlay:setBounds', (_evt, args: { x?: number; y?: number; width?: number; height?: number }) => {
  if (!overlayWindow) return { ok: false }
  const b = overlayWindow.getBounds()
  const x = typeof args.x === 'number' ? Math.max(0, Math.floor(args.x)) : b.x
  const y = typeof args.y === 'number' ? Math.max(0, Math.floor(args.y)) : b.y
  const width = typeof args.width === 'number' ? Math.max(220, Math.floor(args.width)) : b.width
  const height = typeof args.height === 'number' ? Math.max(40, Math.floor(args.height)) : b.height
  // 拖拽/缩放时禁用动画，否则会出现闪动与跟手差
  overlayWindow.setBounds({ ...b, x, y, width, height }, false)
  return { ok: true }
})

ipcMain.on('overlay:setBoundsFast', (_evt, args: { x?: number; y?: number; width?: number; height?: number }) => {
  if (!overlayWindow) return
  const b = overlayWindow.getBounds()
  const x = typeof args.x === 'number' ? Math.max(0, Math.floor(args.x)) : b.x
  const y = typeof args.y === 'number' ? Math.max(0, Math.floor(args.y)) : b.y
  const width = typeof args.width === 'number' ? Math.max(220, Math.floor(args.width)) : b.width
  const height = typeof args.height === 'number' ? Math.max(40, Math.floor(args.height)) : b.height
  overlayWindow.setBounds({ ...b, x, y, width, height }, false)
})

ipcMain.on('overlay:moveStart', () => {
  startOverlayMove()
})

ipcMain.on('overlay:moveStop', () => {
  stopOverlayMove()
})

ipcMain.handle('overlay:restoreLast', (_evt, args: { cols?: number }) => {
  const last = getLastProgress()
  if (!last) return null
  try {
    const { item } = getItemContent(last.itemId)
    const lines = toRawLines(item.contentText)
    const lineIndex = Math.min(last.lineIndex, Math.max(0, lines.length - 1))
    const session = {
      bookId: last.bookId,
      itemId: last.itemId,
      lines,
      lineIndex,
      playing: false
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

