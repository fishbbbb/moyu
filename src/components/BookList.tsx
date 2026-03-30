import React, { useMemo, useRef } from 'react'

export type BookSummaryLike = {
  id: string
  title: string
  domain?: string | null
  sourceRef?: string
  lastReadAt: number | null
  // 可选：若后端额外返回最近一章信息，这里会被优先展示
  lastReadItemTitle?: string | null
}

export function BookList(props: {
  books: BookSummaryLike[]
  activeBookId: string | null
  progressPercentById: Record<string, number>
  latestTextById: Record<string, string>
  onSelectBook: (bookId: string) => void
  onStartReadingBook: (bookId: string) => void
  onRenameBook: (bookId: string) => void
  onDeleteBook: (bookId: string) => void
  onImportTxt: (file: File) => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  const emptyCopy = useMemo(() => {
    return {
      title: '书架为空',
      desc: '导入 TXT 或通过网页采集，把小说内容加入你的阅读库。'
    }
  }, [])

  return (
    <section className="uiPanel uiPanelFlow">
      <div className="uiPanelHead">
        <div className="uiPanelTitle">我的书架</div>
        <label className="uiBtn uiBtnSecondary uiBtnSm uiImportTxtBtn">
          导入 TXT
          <input
            ref={inputRef}
            type="file"
            accept=".txt,text/plain"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) props.onImportTxt(f)
              if (inputRef.current) inputRef.current.value = ''
            }}
          />
        </label>
      </div>

      <div className="uiPanelBody uiPanelBodyTight">
        {props.books.length === 0 ? (
          <div className="uiEmptyFlow" role="status" aria-live="polite">
            <div className="uiEmptyArt">📚</div>
            <div className="uiEmptyTitle">{emptyCopy.title}</div>
            <div className="uiEmptyDesc">{emptyCopy.desc}</div>
          </div>
        ) : (
          <div className="uiBookListFlow" role="list" aria-label="书架列表">
            {props.books.map((b) => {
              const active = props.activeBookId === b.id
              const progress = Math.max(0, Math.min(100, props.progressPercentById[b.id] ?? 0))
              const latest = props.latestTextById[b.id] ?? ''
              return (
                <div
                  key={b.id}
                  className={`uiBookRowFlow ${active ? 'uiBookRowActive' : ''}`}
                  onClick={() => props.onSelectBook(b.id)}
                  onDoubleClick={() => props.onStartReadingBook(b.id)}
                  role="listitem"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') props.onSelectBook(b.id)
                  }}
                >
                  <div className="uiBookProgressTrack" aria-hidden="true">
                    <div className="uiBookProgressFill" style={{ width: `${progress}%` }} />
                  </div>
                  <div className="uiBookMeta">
                    <div className="uiBookTitle" title={b.title}>
                      {b.title}
                    </div>
                    <div className="uiBookLatest" title={latest}>
                      {latest || (active ? '正在阅读' : '最新章节—')}
                    </div>
                  </div>
                  <div className="uiRowActions" aria-hidden={false}>
                    <button
                      className="uiIconBtn"
                      title="重命名"
                      onClick={(e) => {
                        e.stopPropagation()
                        props.onRenameBook(b.id)
                      }}
                    >
                      ✏️
                    </button>
                    <button
                      className="uiIconBtn"
                      title="删除"
                      onClick={(e) => {
                        e.stopPropagation()
                        props.onDeleteBook(b.id)
                      }}
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

