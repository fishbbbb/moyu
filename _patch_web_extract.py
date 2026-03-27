from pathlib import Path

p = Path("/Users/yuuuu/Documents/new/desktop/electron/main.ts")
text = p.read_text(encoding="utf-8")

old1 = """function webExtractErr(code: string, message: string) {
  // ipcRenderer.invoke 传递 Error 时通常只保留 message，因此把 code 编进 message 里。
  return new Error(`WEB_EXTRACT::${code}::${message}`)
}

async function waitWebContentsReady(wc: Electron.WebContents, timeoutMs = 20000) {"""

new1 = """function webExtractErr(code: string, message: string) {
  // ipcRenderer.invoke 传递 Error 时通常只保留 message，因此把 code 编进 message 里。
  return new Error(`WEB_EXTRACT::${code}::${message}`)
}

function isWebExtractLoadTimeout(err: unknown): boolean {
  return err instanceof Error && err.message.includes('WEB_EXTRACT::LOAD_TIMEOUT')
}

async function waitWebContentsReady(wc: Electron.WebContents, timeoutMs = 20000) {"""

if old1 not in text:
    raise SystemExit("old1 not found")
text = text.replace(old1, new1, 1)

old2 = """  const wc = webWindow.webContents
  await waitWebContentsReady(wc)

  // 触发一次懒加载（常见于“滚动后才填充正文/图片占位”页面）
  try {
    await wc.executeJavaScript(`(() => new Promise((resolve) => {
      const maxSteps = 6;"""

new2 = """  const wc = webWindow.webContents
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
      const maxSteps = 6;"""

if old2 not in text:
    raise SystemExit("old2 not found")
text = text.replace(old2, new2, 1)

old3 = """  const readyState = String(res?.readyState ?? '')

  let domain: string | null = null"""

new3 = """  const readyState = String(res?.readyState ?? '')
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

  let domain: string | null = null"""

# Only replace first occurrence (web:extract handler)
if old3 not in text:
    raise SystemExit("old3 not found")
text = text.replace(old3, new3, 1)

p.write_text(text, encoding="utf-8")
print("ok")
