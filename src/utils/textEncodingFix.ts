/**
 * 中文 TXT 乱码/编码修复（由 web_encoding_tool/fix_encoding_core.py 迁入）
 * 导入时自动选最优解码，输出 UTF-8 字符串。
 */

const CJK_START = 0x4e00
const CJK_END = 0x9fff

const MOJIBAKE_TOKENS = ['锟', '銆', '嚙', '�', 'Ã', 'Â'] as const

export type EncodingFixResult = {
  text: string
  method: string
  hanRatio: number
  length: number
  fffd: number
  /** 是否相对「裸 UTF-8」做了替换解码 */
  changed: boolean
}

function hanRatio(text: string): number {
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= CJK_START && c <= CJK_END) cjk += 1
  }
  return cjk / Math.max(1, text.length)
}

function mojibakePenalty(text: string): number {
  if (!text) return 1
  let hits = 0
  for (const tok of MOJIBAKE_TOKENS) hits += text.split(tok).length - 1
  const dens = hits / Math.max(1, text.length)
  return Math.min(0.5, dens * 10)
}

function detectDoubleMojibake(s: string): boolean {
  return MOJIBAKE_TOKENS.some((tok) => s.includes(tok))
}

function cleanupReadability(text: string): string {
  let s = text
  for (const bad of ['锟斤拷', '嚙', '銆']) s = s.replaceAll(bad, '')
  s = s.replaceAll('Ã€', '€').replaceAll('Â', '')
  s = s.replace(/[ \t]{2,}/g, ' ')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s
}

function scoreTuple(text: string, isView: boolean, preferView: boolean): [number, number, number] {
  const hr = hanRatio(text)
  const pen = mojibakePenalty(text)
  const bonusLen = Math.min(text.length / 1_000_000, 0.1)
  const bias = preferView && isView ? 0.002 : 0
  return [hr + bias, -pen, bonusLen]
}

function cmpScore(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return b[0] - a[0]
  if (a[1] !== b[1]) return b[1] - a[1]
  return b[2] - a[2]
}

function decodeLabel(label: string, data: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: false }).decode(data)
  } catch {
    return null
  }
}

/** 把「乱码视图」按单字节编码还原成 bytes，再按目标编码解码 */
function reversibleFromView(textView: string, encFrom: 'latin1' | 'windows-1252', encTo: string): string {
  const bytes = new Uint8Array(textView.length)
  for (let i = 0; i < textView.length; i++) {
    const code = textView.charCodeAt(i)
    bytes[i] = code <= 0xff ? code : 0x3f
  }
  // latin1 / windows-1252 在「从 charCode 还原」场景下等价于按字节回填
  void encFrom
  return decodeLabel(encTo, bytes) ?? textView
}

type Cand = { method: string; text: string; score: [number, number, number] }

function tryPipelinesFromBytes(data: Uint8Array, refine = false): Cand[] {
  const results: Cand[] = []
  const garbledUtf8 = decodeLabel('utf-8', data) ?? ''
  const preferView = detectDoubleMojibake(garbledUtf8)

  const push = (method: string, text: string | null, isView: boolean) => {
    if (text == null) return
    results.push({ method, text, score: scoreTuple(text, isView, preferView) })
  }

  // UTF-8 必须作为候选，避免正常 UTF-8 中文被误判成 GBK
  push('direct-utf-8', garbledUtf8, false)

  for (const enc of ['gb18030', 'gbk'] as const) {
    push(`direct-${enc}`, decodeLabel(enc, data), false)
  }
  if (refine) {
    push('direct-big5', decodeLabel('big5', data), false)
  }

  for (const mid of ['latin1', 'windows-1252'] as const) {
    for (const final of ['gbk', 'gb18030'] as const) {
      const t = reversibleFromView(garbledUtf8, mid, final)
      push(`utf8->view->${mid}->${final}`, t, true)
    }
  }

  if (refine) {
    push('utf8->view->gbk->utf8', reversibleFromView(garbledUtf8, 'latin1', 'utf-8'), true)
    push('utf8->view->big5->utf8', reversibleFromView(garbledUtf8, 'latin1', 'big5'), true)
  }

  results.sort((a, b) => cmpScore(a.score, b.score))
  return results
}

/**
 * 从 TXT 原始字节自动选最优解码结果。
 * doClean：去掉常见可见乱码碎片（默认开，导入场景更可读）
 */
export function fixTextBytes(data: ArrayBuffer | Uint8Array, opts?: { clean?: boolean; refine?: boolean }): EncodingFixResult {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const clean = opts?.clean !== false
  const refine = Boolean(opts?.refine)
  const cands = tryPipelinesFromBytes(bytes, refine)
  const best = cands[0]
  const utf8 = cands.find((c) => c.method === 'direct-utf-8')
  let text = best?.text ?? ''
  const method = best?.method ?? 'none'
  if (clean) text = cleanupReadability(text)
  const hr = hanRatio(text)
  const changed = Boolean(utf8 && method !== 'direct-utf-8' && text !== utf8.text)
  return {
    text,
    method,
    hanRatio: hr,
    length: text.length,
    fffd: text.split('\uFFFD').length - 1,
    changed
  }
}

export function describeEncodingMethod(method: string): string | null {
  if (!method || method === 'direct-utf-8' || method === 'none') return null
  if (method.includes('gb18030')) return 'GB18030'
  if (method.includes('gbk')) return 'GBK'
  if (method.includes('big5')) return 'Big5'
  if (method.startsWith('utf8->view')) return '自动修复乱码'
  return '自动识别编码'
}
