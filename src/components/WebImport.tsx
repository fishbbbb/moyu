import React from 'react'

type WebPreviewArticle = {
  title: string
  url: string
  domain: string | null
  contentText: string
  preview: string
}

type WebPreviewBook = {
  bookTitle: string
  detailUrl: string
  domain: string | null
  introText: string
  chapters: Array<{ title: string; url: string }>
}

export function WebImport(props: {
  open: boolean
  onToggleOpen: () => void
  webUrl: string
  onChangeWebUrl: (v: string) => void
  webLoading: boolean
  webErr: string | null
  webErrCode: string | null
  webPreview: WebPreviewArticle | null
  webBookPreview: WebPreviewBook | null
  onExtract: () => void
  onManualSelect: () => void
  onSaveWeb: () => void
  onImportWebBook: () => void
}) {
  return (
    <section className="uiPanel">
      <div className="uiPanelHead uiPanelHeadClickable" onClick={props.onToggleOpen} role="button" tabIndex={0}>
        <div className="uiPanelTitle">网页采集</div>
        <div className={`uiPanelChevron ${props.open ? 'uiPanelChevronOpen' : ''}`} aria-hidden="true">
          ▾
        </div>
      </div>

      <div className={`uiCollapse ${props.open ? 'uiCollapseOpen' : ''}`}>
        <div className="uiCollapseInner">
          <div className="uiPanelBody">
            <div className="uiInputRow">
              <input
                className="uiTextInputBottom"
                value={props.webUrl}
                placeholder="输入小说目录页或章节页 URL"
                onChange={(e) => props.onChangeWebUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') props.onExtract()
                }}
                disabled={props.webLoading}
              />
              <button className="uiBtn uiBtnPrimary uiBtnSm" onClick={props.onExtract} disabled={props.webLoading}>
                {props.webLoading ? '提取中...' : '提取'}
              </button>
            </div>
            <div className="uiHint">支持目录页或章节页，系统会自动识别。</div>

            {props.webErr ? (
              <div className="uiInlineError" role="alert">
                <div>
                  <div className="uiInlineErrorTitle">{props.webErr}</div>
                  {props.webErrCode ? <div className="uiInlineErrorCode">({props.webErrCode})</div> : null}
                </div>
                <button className="uiBtn uiBtnSecondary uiBtnSm" onClick={props.onManualSelect} disabled={props.webLoading}>
                  手动框选
                </button>
              </div>
            ) : null}

            {props.webPreview ? (
              <div className="uiPreviewBox" aria-label="提取结果预览">
                <div className="uiPreviewHead">
                  <div className="uiPreviewTitle">{props.webPreview.title}</div>
                  <button className="uiBtn uiBtnPrimary uiBtnSm" onClick={props.onSaveWeb} disabled={props.webLoading}>
                    保存到书架
                  </button>
                </div>
                <pre className="uiPreviewText">{props.webPreview.preview || '（暂无预览）'}</pre>
              </div>
            ) : null}

            {props.webBookPreview ? (
              <div className="uiPreviewBox" aria-label="目录提取结果预览">
                <div className="uiPreviewHead">
                  <div className="uiPreviewTitle">{props.webBookPreview.bookTitle}</div>
                  <button className="uiBtn uiBtnPrimary uiBtnSm" onClick={props.onImportWebBook} disabled={props.webLoading}>
                    保存到书架
                  </button>
                </div>
                <div className="uiHint">
                  将写入书架：第 1 条为「简介」，其后 {props.webBookPreview.chapters.length} 个章节链接；来源见书架副标题域名。
                </div>
                <div
                  className="uiPreviewToc"
                  style={{ maxHeight: 220, overflow: 'auto', marginTop: 8, fontSize: 13, lineHeight: 1.45 }}
                >
                  <div className="uiPreviewTocRow" title={props.webBookPreview.introText || ''}>
                    <strong>1.</strong> 简介
                    <span style={{ color: 'var(--muted, #666)', marginLeft: 6 }}>
                      {props.webBookPreview.introText
                        ? `${props.webBookPreview.introText.slice(0, 72)}${props.webBookPreview.introText.length > 72 ? '…' : ''}`
                        : '（暂无简介摘要，导入后首条仍占位）'}
                    </span>
                  </div>
                  {props.webBookPreview.chapters.map((c, i) => (
                    <div key={`${c.url}-${i}`} className="uiPreviewTocRow" title={c.url} style={{ marginTop: 4 }}>
                      <strong>{i + 2}.</strong> {c.title || `章节 ${i + 1}`}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}

