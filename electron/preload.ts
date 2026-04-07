import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  overlaySetConfig: (cfg: { opacity?: number; contentProtection?: boolean }) => ipcRenderer.invoke('overlay:setConfig', cfg),

  libraryListBooks: () => ipcRenderer.invoke('library:listBooks'),
  libraryGetBook: (bookId: string) => ipcRenderer.invoke('library:getBook', { bookId }),
  libraryImportTxt: (args: { title: string; sourceRef: string; items: Array<{ title: string; contentText: string }> }) =>
    ipcRenderer.invoke('library:importTxt', args),
  libraryImportWebItem: (args: {
    title: string
    sourceUrl: string
    contentText: string
    domain: string | null
    bookId?: string | null
  }) => ipcRenderer.invoke('library:importWebItem', args),
  libraryImportWebBook: (args: {
    bookTitle: string
    detailUrl: string
    domain: string | null
    introText?: string | null
    chapters: Array<{ title: string; url: string }>
  }) => ipcRenderer.invoke('library:importWebBook', args),
  libraryUpdateItemContent: (args: { itemId: string; contentText: string }) => ipcRenderer.invoke('library:updateItemContent', args),
  libraryRenameBook: (args: { bookId: string; title: string }) => ipcRenderer.invoke('library:renameBook', args),
  bookRename: (args: { bookId: string; newTitle: string }) => ipcRenderer.invoke('book:rename', args),
  bookDelete: (args: { bookId: string }) => ipcRenderer.invoke('book:delete', args),
  bookDeleteMany: (args: { bookIds: string[] }) => ipcRenderer.invoke('book:deleteMany', args),
  bookSearch: (args: { query: string }) => ipcRenderer.invoke('book:search', args),
  libraryListGroups: () => ipcRenderer.invoke('library:listGroups'),
  libraryCreateGroup: (args: { title: string; parentId?: string | null }) => ipcRenderer.invoke('library:createGroup', args),
  libraryRenameGroup: (args: { groupId: string; title: string }) => ipcRenderer.invoke('library:renameGroup', args),
  libraryDeleteGroup: (args: { groupId: string; mode: 'keepBooks' | 'deleteBooks' }) => ipcRenderer.invoke('library:deleteGroup', args),
  libraryMoveBooks: (args: { bookIds: string[]; groupId: string | null }) => ipcRenderer.invoke('library:moveBooks', args),
  libraryDeleteBooks: (args: { bookIds: string[] }) => ipcRenderer.invoke('library:deleteBooks', args),

  webOpen: (args: { url: string }) => ipcRenderer.invoke('web:open', args),
  webExtract: () => ipcRenderer.invoke('web:extract'),
  webExtractAtUrl: (args: { url: string }) => ipcRenderer.invoke('web:extractAtUrl', args),
  webExtractStructuredAtUrl: (args: { url: string }) => ipcRenderer.invoke('web:extractStructuredAtUrl', args),
  webExtractFromSelection: (args?: { rect?: { x: number; y: number; width: number; height: number } }) =>
    ipcRenderer.invoke('web:extractFromSelection', args ?? {}),
  webRefresh: () => ipcRenderer.invoke('web:refresh'),
  webExtractBookDetail: () => ipcRenderer.invoke('web:extractBookDetail'),
  webClose: () => ipcRenderer.invoke('web:close'),

  overlayGetSession: () => ipcRenderer.invoke('overlay:getSession'),
  overlayPushSession: (args: { bookId: string; itemId: string; lines: string[]; lineIndex?: number; playing?: boolean }) =>
    ipcRenderer.invoke('overlay:pushSession', args),
  overlayResume: (args: { bookId: string; cols: number }) => ipcRenderer.invoke('overlay:resume', args),
  overlayRestoreLast: (args: { cols?: number }) => ipcRenderer.invoke('overlay:restoreLast', args),
  overlaySetPlaying: (playing: boolean) => ipcRenderer.invoke('overlay:setPlaying', { playing }),
  // 渲染进程（OverlayView）在自动阅读时会自己推进 idx；这里把“当前页”同步回主进程，
  // 避免主进程在 setPlaying/broadcast 时用旧的 lineIndex 覆盖回起始页。
  overlaySyncLineIndex: (args: { lineIndex: number }) => ipcRenderer.invoke('overlay:syncLineIndex', args),
  // 透明窗口在 macOS 下可能出现合成残影：由主进程触发一次强制重绘/取帧
  overlayForceRepaint: () => ipcRenderer.invoke('overlay:forceRepaint'),
  overlayHide: () => ipcRenderer.invoke('overlay:hide'),
  overlayToolbarToggle: () => ipcRenderer.invoke('overlay:toolbarToggle'),
  overlaySettingsToggle: () => ipcRenderer.invoke('overlay:settingsToggle'),
  overlayToolbarShow: () => ipcRenderer.invoke('overlay:toolbarShow'),
  overlayToolbarHide: () => ipcRenderer.invoke('overlay:toolbarHide'),
  overlaySettingsShow: () => ipcRenderer.invoke('overlay:settingsShow'),
  overlaySettingsHide: () => ipcRenderer.invoke('overlay:settingsHide'),
  overlayAuxHideAll: () => ipcRenderer.invoke('overlay:auxHideAll'),
  overlayAuxHideAllSmart: () => ipcRenderer.invoke('overlay:auxHideAllSmart'),
  overlayGetBounds: () => ipcRenderer.invoke('overlay:getBounds'),
  overlayStep: (delta: number) => ipcRenderer.invoke('overlay:step', { delta }),
  overlayStepDisplay: (delta: number) => ipcRenderer.invoke('overlay:stepDisplay', { delta }),
  overlayKModeSet: (enabled: boolean) => ipcRenderer.invoke('overlay:kModeSet', { enabled }),
  overlaySetBounds: (args: { x?: number; y?: number; width?: number; height?: number }) => ipcRenderer.invoke('overlay:setBounds', args),
  overlaySetBoundsFast: (args: { x?: number; y?: number; width?: number; height?: number }) => ipcRenderer.send('overlay:setBoundsFast', args),
  overlayMoveStart: () => ipcRenderer.send('overlay:moveStart'),
  overlayMoveStop: () => ipcRenderer.send('overlay:moveStop'),
  overlayChapterStep: (delta: number) => ipcRenderer.invoke('overlay:chapterStep', { delta }),

  progressSet: (args: { bookId: string; itemId: string; lineIndex: number }) => ipcRenderer.invoke('progress:set', args),

  overlayOnSession: (cb: (session: unknown) => void) => {
    const handler = (_evt: unknown, session: unknown) => cb(session)
    ipcRenderer.on('overlay:session', handler)
    return () => ipcRenderer.off('overlay:session', handler)
  },

  overlayOnBounds: (cb: (bounds: unknown) => void) => {
    const handler = (_evt: unknown, bounds: unknown) => cb(bounds)
    ipcRenderer.on('overlay:bounds', handler)
    return () => ipcRenderer.off('overlay:bounds', handler)
  },

  overlayOnStepDisplay: (cb: (payload: unknown) => void) => {
    const handler = (_evt: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('overlay:stepDisplay', handler)
    return () => ipcRenderer.off('overlay:stepDisplay', handler)
  },

  overlayOnKMode: (cb: (payload: unknown) => void) => {
    const handler = (_evt: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('overlay:kMode', handler)
    return () => ipcRenderer.off('overlay:kMode', handler)
  }
})

export type Api = typeof globalThis & {
  api: {
    overlaySetConfig: (cfg: { opacity?: number; contentProtection?: boolean }) => Promise<void>
    libraryListBooks: () => Promise<unknown>
    libraryGetBook: (bookId: string) => Promise<unknown>
    libraryImportTxt: (args: { title: string; sourceRef: string; items: Array<{ title: string; contentText: string }> }) => Promise<unknown>
    libraryImportWebItem: (args: {
      title: string
      sourceUrl: string
      contentText: string
      domain: string | null
      bookId?: string | null
    }) => Promise<unknown>
    libraryImportWebBook: (args: {
      bookTitle: string
      detailUrl: string
      domain: string | null
      introText?: string | null
      chapters: Array<{ title: string; url: string }>
    }) => Promise<unknown>
    libraryUpdateItemContent: (args: { itemId: string; contentText: string }) => Promise<unknown>
    libraryRenameBook: (args: { bookId: string; title: string }) => Promise<unknown>
    bookRename: (args: { bookId: string; newTitle: string }) => Promise<unknown>
    bookDelete: (args: { bookId: string }) => Promise<unknown>
    bookDeleteMany: (args: { bookIds: string[] }) => Promise<unknown>
    bookSearch: (args: { query: string }) => Promise<unknown>
    libraryListGroups: () => Promise<unknown>
    libraryCreateGroup: (args: { title: string; parentId?: string | null }) => Promise<unknown>
    libraryRenameGroup: (args: { groupId: string; title: string }) => Promise<unknown>
    libraryDeleteGroup: (args: { groupId: string; mode: 'keepBooks' | 'deleteBooks' }) => Promise<unknown>
    libraryMoveBooks: (args: { bookIds: string[]; groupId: string | null }) => Promise<unknown>
    libraryDeleteBooks: (args: { bookIds: string[] }) => Promise<unknown>

    webOpen: (args: { url: string }) => Promise<unknown>
    webExtract: () => Promise<unknown>
    webExtractAtUrl: (args: { url: string }) => Promise<unknown>
    webExtractStructuredAtUrl: (args: { url: string }) => Promise<unknown>
    webExtractFromSelection: (args?: { rect?: { x: number; y: number; width: number; height: number } }) => Promise<unknown>
    webRefresh: () => Promise<unknown>
    webExtractBookDetail: () => Promise<unknown>
    webClose: () => Promise<unknown>

    overlayGetSession: () => Promise<unknown>
    overlayPushSession: (args: { bookId: string; itemId: string; lines: string[]; lineIndex?: number; playing?: boolean }) => Promise<unknown>
    overlayResume: (args: { bookId: string; cols: number }) => Promise<unknown>
    overlayRestoreLast: (args: { cols?: number }) => Promise<unknown>
    overlaySetPlaying: (playing: boolean) => Promise<unknown>
    overlaySyncLineIndex: (args: { lineIndex: number }) => Promise<unknown>
    overlayForceRepaint: () => Promise<unknown>
    overlayHide: () => Promise<unknown>
    overlayToolbarToggle: () => Promise<unknown>
    overlaySettingsToggle: () => Promise<unknown>
    overlayToolbarShow: () => Promise<unknown>
    overlayToolbarHide: () => Promise<unknown>
    overlaySettingsShow: () => Promise<unknown>
    overlaySettingsHide: () => Promise<unknown>
    overlayAuxHideAll: () => Promise<unknown>
    overlayAuxHideAllSmart: () => Promise<unknown>
    overlayGetBounds: () => Promise<unknown>
    overlayStep: (delta: number) => Promise<unknown>
    overlayStepDisplay: (delta: number) => Promise<unknown>
    overlaySetBounds: (args: { x?: number; y?: number; width?: number; height?: number }) => Promise<unknown>
    overlaySetBoundsFast: (args: { x?: number; y?: number; width?: number; height?: number }) => void

    progressSet: (args: { bookId: string; itemId: string; lineIndex: number }) => Promise<unknown>
    overlayOnSession: (cb: (session: unknown) => void) => () => void
    overlayOnBounds: (cb: (bounds: unknown) => void) => () => void
    overlayOnStepDisplay: (cb: (payload: unknown) => void) => () => void
  }
}

