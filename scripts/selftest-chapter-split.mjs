import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Selftest runner for chapter splitting.
// Run: npm run selftest:chapters

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function assert(cond, msg) {
  if (!cond) {
    const err = new Error(`SELFTEST_ASSERT_FAILED: ${msg}`)
    err.name = 'SelftestAssertError'
    throw err
  }
}

function normalizeNewlines(s) {
  return String(s ?? '').replace(/\r\n/g, '\n')
}

function normalizeBlankLines(text) {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t\u3000]+$/g, ''))
    .filter((l) => l.replace(/[ \t\u3000]/g, '').length > 0)
  return lines.join('\n')
}

// Keep this logic mirrored with src/utils/chapterSplit.ts (same regex+heuristics).
function splitTextToChaptersForSelftest(inputText) {
  const rawLines = normalizeNewlines(inputText).split('\n')

  const chapterReList = [
    /^\s*第\s*[零一二三四五六七八九十百千两0-9]+\s*[章回节卷话集篇幕部][\s:：\-—_.、·]*.*$/,
    /^\s*Chapter\s+\d+\b.*$/i,
    /^\s*CHAPTER\s+\d+\b.*$/,
    /^\s*卷\s*[零一二三四五六七八九十百千两0-9]+[\s:：\-—_.、·]*.*$/,
    /^\s*(序章|序|楔子|引子|前言|扉页|正文|后记|完结感言|终章|最终章|尾声|番外|外传|附录|幕间|间章)[\s:：\-—_.、·]*.*$/,
    /^\s*(Prologue|Epilogue|Afterword|Preface|Appendix|Interlude|Extra)\b[\s:：\-—_.、·]*.*$/i
  ]

  const isLikelyHeadingLine = (lineTrimmed, prevTrimmed, nextTrimmed) => {
    if (!lineTrimmed) return false

    // 对“强章节标题”（第X章/卷X/Chapter X）放宽过滤：
    // 很多小说的标题行是“标题 + 一段补充文案”，后半段会带 `，。` 等标点。
    // 否则会把这种行误判成“正文句子”，导致章节稀疏跳号。
    const isStrongChapterTitle =
      /^\s*第\s*[零一二三四五六七八九十百千两0-9]+\s*[章回节卷话集篇幕部]/.test(lineTrimmed) ||
      /^\s*(Chapter|CHAPTER)\s+\d+\b/i.test(lineTrimmed) ||
      /^\s*卷\s*[零一二三四五六七八九十百千两0-9]+/.test(lineTrimmed)
    if (isStrongChapterTitle) {
      // 标题行通常不会长到像整段正文；给一个相对宽松的上限，避免误把正文开头当标题。
      if (lineTrimmed.length > 120) return false
      return true
    }

    if (/[。！？；;：:，,]/.test(lineTrimmed)) return false
    if (lineTrimmed.length > 60) return false
    const isolated = !prevTrimmed || !nextTrimmed
    const shortEnough = lineTrimmed.length <= 40
    return isolated || shortEnough
  }

  const hits = []
  for (let i = 0; i < rawLines.length; i++) {
    const line = (rawLines[i] ?? '').trim()
    if (!line) continue
    if (!chapterReList.some((re) => re.test(line))) continue
    const prevTrimmed = (rawLines[i - 1] ?? '').trim()
    const nextTrimmed = (rawLines[i + 1] ?? '').trim()
    if (!isLikelyHeadingLine(line, prevTrimmed, nextTrimmed)) continue
    hits.push({ title: line, lineIndex: i })
  }

  const makeContent = (start, end) => normalizeBlankLines(rawLines.slice(start, end).join('\n')).trim()

  if (hits.length < 2) {
    const contentText = normalizeBlankLines(rawLines.join('\n')).trim()
    return [{ title: '全文', contentText }]
  }

  const gaps = []
  for (let i = 1; i < hits.length; i++) gaps.push((hits[i].lineIndex ?? 0) - (hits[i - 1].lineIndex ?? 0))
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 999
  if (hits.length >= 8 && avgGap < 4) {
    const contentText = normalizeBlankLines(rawLines.join('\n')).trim()
    return [{ title: '全文', contentText }]
  }

  const items = []
  const firstStart = hits[0].lineIndex
  if (firstStart > 0) {
    const headText = makeContent(0, firstStart)
    if (headText.replace(/\s+/g, '').length >= 80) items.push({ title: '开头', contentText: headText })
  }
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].lineIndex
    const end = i + 1 < hits.length ? hits[i + 1].lineIndex : rawLines.length
    const contentText = makeContent(start, end)
    items.push({ title: hits[i].title, contentText })
  }
  return items.filter((it) => String(it.contentText ?? '').trim().length > 0)
}

function summarize(items) {
  const titles = items.slice(0, 5).map((x) => x.title)
  return {
    count: items.length,
    firstTitle: items[0]?.title ?? null,
    firstLen: (items[0]?.contentText ?? '').length,
    sampleTitles: titles
  }
}

function runCase(name, text, expect) {
  const items = splitTextToChaptersForSelftest(text)
  const sum = summarize(items)
  console.log(`\n[${name}]`, sum)
  if (expect?.minCount != null) assert(items.length >= expect.minCount, `${name}: expected minCount>=${expect.minCount}, got ${items.length}`)
  if (expect?.maxCount != null) assert(items.length <= expect.maxCount, `${name}: expected maxCount<=${expect.maxCount}, got ${items.length}`)
  if (expect?.firstTitleIncludes != null)
    assert(String(items[0]?.title ?? '').includes(expect.firstTitleIncludes), `${name}: firstTitle should include "${expect.firstTitleIncludes}", got "${items[0]?.title ?? ''}"`)
  if (expect?.shouldBeFull === true) assert(items.length === 1 && items[0]?.title === '全文', `${name}: expected to fallback to 全文`)
  if (expect?.shouldNotBeFull === true) assert(!(items.length === 1 && items[0]?.title === '全文'), `${name}: expected NOT to fallback to 全文`)
  if (expect?.noBlankLines === true) {
    for (const it of items) {
      assert(!String(it.contentText ?? '').includes('\n\n'), `${name}: content should not contain blank lines (found \\n\\n) in "${it.title}"`)
    }
  }
}

function main() {
  console.log('Running chapter split selftest…')

  // 1) No headings → full
  runCase(
    'no-headings',
    `这是一个没有明确章节的文本。\n只有连续正文。\n其中也可能出现“第一话”这种词，但不应切分。\n他在第一话就登场了。`,
    { shouldBeFull: true }
  )

  // 1b) 多空行应被压缩（不影响分章，但避免阅读出现大片空白）
  runCase(
    'many-blank-lines-collapse',
    `第 1 话\n\n\n\n第一段\n\n\n\n\n第二段\n\n\n第 2 话\n\n\n第三段`,
    { shouldNotBeFull: true, minCount: 2, noBlankLines: true }
  )

  // 2) Proper 第X话 (no spaces)
  runCase(
    'basic-diXhua-nospace',
    `第1话 开端\n这里是第一话正文。\n\n第2话 继续\n这里是第二话正文。`,
    { shouldNotBeFull: true, minCount: 2, firstTitleIncludes: '第1话' }
  )

  // 3) Proper 第 X 话 (with spaces) → must work (your cds.txt case)
  runCase(
    'basic-diXhua-spaces',
    `前言：一些说明。\n\n第 2 话\n第二话正文。\n\n第 3 话\n第三话正文。`,
    { shouldNotBeFull: true, minCount: 2, firstTitleIncludes: '第 2 话' }
  )

  // 3c) 强章节标题后半段带标点/省略号：应仍能正确切
  runCase(
    'strong-chapter-title-with-punctuation',
    `第1章 开端\n这里是第一章正文。\n第2章 胭脂骨 郎呀郎，巴不得下世你为女来我……\n这里是第二章正文继续。\n第3章 好友 两人那叫一个臭味相投，沆瀣一气……\n这里是第三章正文继续。`,
    { shouldNotBeFull: true, minCount: 3, firstTitleIncludes: '第1章' }
  )

  // 3b) Head insertion: 第一章不从开头开始，且开头足够长 → should add “开头”
  runCase(
    'head-insertion',
    `${'这是开头内容。'.repeat(50)}\n\n第 2 话\n第二话正文。\n\n第 3 话\n第三话正文。`,
    { shouldNotBeFull: true, minCount: 3, firstTitleIncludes: '开头' }
  )

  // 4) “正文句子里出现第X话”不应切
  runCase(
    'inline-mention-should-not-split',
    `这一段正文里提到了第 2 话，但它不是标题行。\n后面仍然是正文。\n没有独立标题行。`,
    { shouldBeFull: true }
  )

  // 5) Prologue/Epilogue
  runCase(
    'english-prologue',
    `Prologue\nText...\n\nChapter 1 The Start\nText...\n\nEpilogue\nText...`,
    { shouldNotBeFull: true, minCount: 2 }
  )

  // 6) 序章/终章/番外
  runCase(
    'cn-special-headings',
    `序章\n一些内容\n\n第一章\n一些内容\n\n番外\n一些内容\n\n终章\n一些内容`,
    { shouldNotBeFull: true, minCount: 2 }
  )

  // 7) Over-splitting guard: too dense headings → fallback full
  runCase(
    'too-dense-headings-should-fallback',
    `第1话\nx\n第2话\ny\n第3话\nz\n第4话\nw\n第5话\nu\n第6话\nv\n第7话\np\n第8话\nq`,
    { shouldBeFull: true }
  )

  // 8) Real file case (optional)
  const realPath = process.env.SELFTEST_REAL_TXT
  if (realPath) {
    const p = path.isAbsolute(realPath) ? realPath : path.join(__dirname, '..', realPath)
    const buf = fs.readFileSync(p, 'utf8')
    runCase(`real-file:${p}`, buf, { shouldNotBeFull: true, minCount: 3 })
  } else {
    console.log('\n[real-file] skipped (set SELFTEST_REAL_TXT=/absolute/path/to.txt)')
  }

  console.log('\nSelftest OK.')
}

main()

