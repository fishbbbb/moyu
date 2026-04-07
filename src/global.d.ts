export {}

declare global {
  interface Window {
    api?: {
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
      overlayKModeSet: (enabled: boolean) => Promise<unknown>
      overlaySetBounds: (args: { x?: number; y?: number; width?: number; height?: number }) => Promise<unknown>
      overlaySetBoundsFast: (args: { x?: number; y?: number; width?: number; height?: number }) => void
      overlayMoveStart: () => void
      overlayMoveStop: () => void
      overlayChapterStep: (delta: number) => Promise<unknown>

      progressSet: (args: { bookId: string; itemId: string; lineIndex: number }) => Promise<unknown>
      overlayOnSession: (cb: (session: unknown) => void) => () => void
      overlayOnBounds: (cb: (bounds: unknown) => void) => () => void
      overlayOnStepDisplay: (cb: (payload: unknown) => void) => () => void
      overlayOnKMode: (cb: (payload: unknown) => void) => () => void
    }
  }
}

