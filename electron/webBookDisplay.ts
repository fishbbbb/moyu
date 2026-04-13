/**
 * 书架展示用书名：与 PRD《网页提取与书架规范》§3.1 一致，避免把作者/站点/标签拼进 books.title。
 */
export function sanitizeWebBookShelfTitle(raw: string): string {
  const s = String(raw ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return '未命名网页'

  const quoted = s.match(/《[^》]+》/)
  if (quoted) return quoted[0].trim()

  let t = s.replace(/【[^】]*】/g, ' ').replace(/\s+/g, ' ').trim()
  const beforeUnderscore = t.split('_')[0]?.trim()
  if (beforeUnderscore && beforeUnderscore.length >= 2 && beforeUnderscore.length < 96) {
    t = beforeUnderscore
  }

  t = t.replace(/\s*[-|｜]\s*.{0,48}文学城.*$/i, '').trim()
  t = t.replace(/\s+_/g, ' ').trim()

  return t || '未命名网页'
}
