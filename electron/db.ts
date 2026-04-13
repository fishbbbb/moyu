import { app } from 'electron'
import path from 'node:path'
import Database from 'better-sqlite3'

export type BookRow = {
  id: string
  title: string
  sourceType: 'file' | 'url'
  sourceRef: string
  domain: string | null
  groupId: string | null
  createdAt: number
  updatedAt: number
}

export type GroupRow = {
  id: string
  title: string
  parentId: string | null
  orderIndex: number
  createdAt: number
  updatedAt: number
}

export type ItemRow = {
  id: string
  bookId: string
  title: string
  sourceUrl: string | null
  orderIndex: number
  contentText: string
  createdAt: number
}

export type ProgressRow = {
  bookId: string
  itemId: string
  lineIndex: number
  updatedAt: number
}

/** 网页下一章启发式多候选时供用户在阅读条内点选（主进程随 session 下发） */
export type WebNextChapterCandidate = {
  url: string
  label: string
  confidence: number
  reason: string
}

export type OverlaySession = {
  bookId: string
  itemId: string
  lines: string[]
  lineIndex: number
  playing: boolean
  webNextCandidates?: WebNextChapterCandidate[]
  /** 当前章节来源 URL，便于与候选对比 */
  webChapterSourceUrl?: string | null
}

let db: Database.Database | null = null
let session: OverlaySession | null = null

function nowMs() {
  return Date.now()
}

export function getOverlaySession() {
  return session
}

export function setOverlaySession(next: OverlaySession | null) {
  session = next
}

export function getDb() {
  if (db) return db
  const dbPath = path.join(app.getPath('userData'), 'app.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function getUserVersion(d: Database.Database) {
  const row = d.prepare(`PRAGMA user_version`).get() as any
  return Number(row?.user_version ?? 0)
}

function setUserVersion(d: Database.Database, v: number) {
  d.pragma(`user_version = ${Math.max(0, Math.floor(v))}`)
}

function hasColumn(d: Database.Database, table: string, column: string) {
  const rows = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((r) => r.name === column)
}

function migrate(d: Database.Database) {
  // v0 baseline schema (existing installs may already have these tables)
  d.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      sourceType TEXT NOT NULL,
      sourceRef TEXT NOT NULL,
      domain TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_books_updatedAt ON books(updatedAt DESC);

    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      bookId TEXT NOT NULL,
      title TEXT NOT NULL,
      sourceUrl TEXT,
      orderIndex INTEGER NOT NULL,
      contentText TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      FOREIGN KEY(bookId) REFERENCES books(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_items_bookId_order ON items(bookId, orderIndex);

    CREATE TABLE IF NOT EXISTS progress (
      bookId TEXT PRIMARY KEY,
      itemId TEXT NOT NULL,
      lineIndex INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  let v = getUserVersion(d)
  if (v < 1) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        parentId TEXT,
        orderIndex INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_groups_parent_order ON groups(parentId, orderIndex);
    `)

    // ALTER TABLE ... ADD COLUMN doesn't support IF NOT EXISTS (older SQLite), so check first.
    if (!hasColumn(d, 'books', 'groupId')) {
      d.exec(`ALTER TABLE books ADD COLUMN groupId TEXT`)
    }

    v = 1
    setUserVersion(d, v)
  }
}

export function listBooks(): Array<BookRow & { lastReadAt: number | null }> {
  const d = getDb()
  return d
    .prepare(
      `
      SELECT
        b.*,
        p.updatedAt as lastReadAt
      FROM books b
      LEFT JOIN progress p ON p.bookId = b.id
      ORDER BY COALESCE(p.updatedAt, b.updatedAt) DESC
    `
    )
    .all() as any
}

export function searchBooks(query: string): Array<BookRow & { lastReadAt: number | null }> {
  const d = getDb()
  const q = `%${String(query ?? '').trim()}%`
  if (!String(query ?? '').trim()) return listBooks()
  return d
    .prepare(
      `
      SELECT
        b.*,
        p.updatedAt as lastReadAt
      FROM books b
      LEFT JOIN progress p ON p.bookId = b.id
      WHERE b.title LIKE ?
      ORDER BY COALESCE(p.updatedAt, b.updatedAt) DESC
    `
    )
    .all(q) as any
}

export function getBook(bookId: string): { book: BookRow; items: ItemRow[]; progress: ProgressRow | null } {
  const d = getDb()
  const book = d.prepare(`SELECT * FROM books WHERE id = ?`).get(bookId) as BookRow | undefined
  if (!book) throw new Error('BOOK_NOT_FOUND')
  const items = d.prepare(`SELECT * FROM items WHERE bookId = ? ORDER BY orderIndex ASC`).all(bookId) as ItemRow[]
  const progress = (d.prepare(`SELECT * FROM progress WHERE bookId = ?`).get(bookId) as ProgressRow | undefined) ?? null
  return { book, items, progress }
}

export function upsertProgress(p: ProgressRow) {
  const d = getDb()
  d.prepare(
    `
      INSERT INTO progress (bookId, itemId, lineIndex, updatedAt)
      VALUES (@bookId, @itemId, @lineIndex, @updatedAt)
      ON CONFLICT(bookId) DO UPDATE SET
        itemId=excluded.itemId,
        lineIndex=excluded.lineIndex,
        updatedAt=excluded.updatedAt
    `
  ).run(p)
}

export function importTxtBook(input: {
  title: string
  sourceRef: string
  items: Array<{ title: string; contentText: string }>
}) {
  const d = getDb()
  const bookId = crypto.randomUUID()
  const createdAt = nowMs()
  const updatedAt = createdAt

  const insertBook = d.prepare(
    `INSERT INTO books (id, title, sourceType, sourceRef, domain, createdAt, updatedAt) VALUES (?, ?, 'file', ?, NULL, ?, ?)`
  )
  const insertItem = d.prepare(
    `INSERT INTO items (id, bookId, title, sourceUrl, orderIndex, contentText, createdAt) VALUES (?, ?, ?, NULL, ?, ?, ?)`
  )

  const tx = d.transaction(() => {
    insertBook.run(bookId, input.title, input.sourceRef, createdAt, updatedAt)
    input.items.forEach((it, idx) => {
      insertItem.run(crypto.randomUUID(), bookId, it.title, idx, it.contentText, createdAt)
    })
  })
  tx()

  return { bookId }
}

export function importWebItem(input: {
  title: string
  sourceUrl: string
  contentText: string
  domain: string | null
  bookId?: string | null
}) {
  const d = getDb()
  const createdAt = nowMs()
  const updatedAt = createdAt
  const existingBookId = input.bookId ?? null

  const insertBook = d.prepare(
    `INSERT INTO books (id, title, sourceType, sourceRef, domain, createdAt, updatedAt) VALUES (?, ?, 'url', ?, ?, ?, ?)`
  )
  const insertItem = d.prepare(
    `INSERT INTO items (id, bookId, title, sourceUrl, orderIndex, contentText, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const selectItemsCount = d.prepare(`SELECT COUNT(1) as count FROM items WHERE bookId = ?`)
  const selectBook = d.prepare(`SELECT id, title, sourceType, sourceRef, domain, createdAt, updatedAt FROM books WHERE id = ?`)
  const updateBookUpdatedAt = d.prepare(`UPDATE books SET updatedAt = ? WHERE id = ?`)

  const tx = d.transaction(() => {
    let bookId = existingBookId
    let book = bookId ? (selectBook.get(bookId) as BookRow | undefined) : undefined
    if (!book) {
      bookId = crypto.randomUUID()
      const bookTitle = input.title?.trim() || '未命名网页'
      const domain = input.domain ?? null
      insertBook.run(bookId, bookTitle, input.sourceUrl, domain, createdAt, updatedAt)
      book = selectBook.get(bookId) as BookRow
    } else if (book.sourceType !== 'url') {
      throw new Error('BOOK_TYPE_MISMATCH')
    } else {
      updateBookUpdatedAt.run(updatedAt, book.id)
    }

    const countRow = (selectItemsCount.get(book.id) as { count: number } | undefined) ?? { count: 0 }
    const orderIndex = Math.max(0, Number(countRow.count ?? 0))
    const itemTitle = input.title?.trim() || `未命名章节 ${orderIndex + 1}`
    insertItem.run(crypto.randomUUID(), book.id, itemTitle, input.sourceUrl, orderIndex, input.contentText, createdAt)

    return { bookId: book.id }
  })

  return tx()
}

export function importWebBook(input: {
  bookTitle: string
  detailUrl: string
  domain: string | null
  introText?: string | null
  chapters: Array<{ title: string; url: string }>
}) {
  const d = getDb()
  const createdAt = nowMs()
  const updatedAt = createdAt
  const bookId = crypto.randomUUID()

  const insertBook = d.prepare(
    `INSERT INTO books (id, title, sourceType, sourceRef, domain, createdAt, updatedAt) VALUES (?, ?, 'url', ?, ?, ?, ?)`
  )
  const insertItem = d.prepare(
    `INSERT INTO items (id, bookId, title, sourceUrl, orderIndex, contentText, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const tx = d.transaction(() => {
    const shelfTitle = input.bookTitle?.trim() || '未命名网页'
    insertBook.run(bookId, shelfTitle, input.detailUrl, input.domain ?? null, createdAt, updatedAt)
    const chapters = (input.chapters ?? []).slice(0, 500)
    const introRaw = String(input.introText ?? '').trim()
    const introContent =
      introRaw ||
      '（本页未抓到简介正文：可回到作品详情页再执行「解析目录」；部分内容可能被站点折叠或需登录后可见。）'
    let order = 0
    insertItem.run(crypto.randomUUID(), bookId, '简介', input.detailUrl, order, introContent, createdAt)
    order = 1
    chapters.forEach((c, idx) => {
      const title = String(c?.title ?? '').trim() || `未命名章节 ${idx + 1}`
      const url = String(c?.url ?? '').trim()
      insertItem.run(crypto.randomUUID(), bookId, title, url || null, order + idx, '', createdAt)
    })
  })
  tx()
  return { bookId }
}

export function updateItemContent(input: { itemId: string; contentText: string }) {
  const d = getDb()
  const itemId = String(input.itemId ?? '')
  if (!itemId) throw new Error('ITEM_NOT_FOUND')
  const contentText = String(input.contentText ?? '').trim()
  if (!contentText) throw new Error('EMPTY_CONTENT')
  const r = d.prepare(`UPDATE items SET contentText = ? WHERE id = ?`).run(contentText, itemId)
  if (r.changes === 0) throw new Error('ITEM_NOT_FOUND')
  return { ok: true }
}

export function getItemContent(itemId: string): { item: ItemRow; book: BookRow } {
  const d = getDb()
  const item = d.prepare(`SELECT * FROM items WHERE id = ?`).get(itemId) as ItemRow | undefined
  if (!item) throw new Error('ITEM_NOT_FOUND')
  const book = d.prepare(`SELECT * FROM books WHERE id = ?`).get(item.bookId) as BookRow | undefined
  if (!book) throw new Error('BOOK_NOT_FOUND')
  return { item, book }
}

/** 取最近阅读的一条进度（用于重启后恢复 Overlay） */
export function getLastProgress(): ProgressRow | null {
  const d = getDb()
  const row = d
    .prepare(`SELECT bookId, itemId, lineIndex, updatedAt FROM progress ORDER BY updatedAt DESC LIMIT 1`)
    .get() as ProgressRow | undefined
  return row ?? null
}

export function renameBook(bookId: string, title: string) {
  const d = getDb()
  const updatedAt = nowMs()
  const r = d.prepare(`UPDATE books SET title = ?, updatedAt = ? WHERE id = ?`).run(title, updatedAt, bookId)
  if (r.changes === 0) throw new Error('BOOK_NOT_FOUND')
  return { ok: true }
}

export function updateBookTitle(bookId: string, newTitle: string) {
  const title = String(newTitle ?? '').trim()
  if (!title) throw new Error('INVALID_TITLE')
  return renameBook(bookId, title)
}

export function deleteBook(bookId: string) {
  const id = String(bookId ?? '').trim()
  if (!id) throw new Error('BOOK_NOT_FOUND')
  // reuse cascade-safe bulk deletion path
  return deleteBooks({ bookIds: [id] })
}

export function listGroups(): GroupRow[] {
  const d = getDb()
  return d
    .prepare(
      `
      SELECT id, title, parentId, orderIndex, createdAt, updatedAt
      FROM groups
      ORDER BY parentId IS NOT NULL, parentId, orderIndex ASC, updatedAt DESC
    `
    )
    .all() as any
}

export function createGroup(input: { title: string; parentId?: string | null }) {
  const d = getDb()
  const id = crypto.randomUUID()
  const createdAt = nowMs()
  const updatedAt = createdAt
  const parentId = input.parentId ?? null

  const selectNextOrder = d.prepare(`SELECT COALESCE(MAX(orderIndex) + 1, 0) as n FROM groups WHERE parentId IS ?`)
  const nextOrder = Number((selectNextOrder.get(parentId) as any)?.n ?? 0)

  d.prepare(
    `INSERT INTO groups (id, title, parentId, orderIndex, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, input.title, parentId, nextOrder, createdAt, updatedAt)

  return { groupId: id }
}

export function renameGroup(groupId: string, title: string) {
  const d = getDb()
  const updatedAt = nowMs()
  const r = d.prepare(`UPDATE groups SET title = ?, updatedAt = ? WHERE id = ?`).run(title, updatedAt, groupId)
  if (r.changes === 0) throw new Error('GROUP_NOT_FOUND')
  return { ok: true }
}

function collectGroupIds(d: Database.Database, rootGroupId: string) {
  const rows = d.prepare(`SELECT id, parentId FROM groups`).all() as Array<{ id: string; parentId: string | null }>
  const byParent = new Map<string | null, string[]>()
  for (const r of rows) {
    const list = byParent.get(r.parentId ?? null) ?? []
    list.push(r.id)
    byParent.set(r.parentId ?? null, list)
  }
  const out: string[] = []
  const stack = [rootGroupId]
  const seen = new Set<string>()
  while (stack.length) {
    const cur = stack.pop()!
    if (seen.has(cur)) continue
    seen.add(cur)
    out.push(cur)
    const kids = byParent.get(cur) ?? []
    for (const k of kids) stack.push(k)
  }
  return out
}

export function deleteGroup(input: { groupId: string; mode: 'keepBooks' | 'deleteBooks' }) {
  const d = getDb()
  const mode = input.mode
  const tx = d.transaction(() => {
    // Ensure group exists
    const g = d.prepare(`SELECT id FROM groups WHERE id = ?`).get(input.groupId) as any
    if (!g) throw new Error('GROUP_NOT_FOUND')

    const groupIds = collectGroupIds(d, input.groupId)
    const placeholders = groupIds.map(() => '?').join(',')

    let deletedBookIds: string[] | undefined
    if (mode === 'deleteBooks') {
      const bookRows = d
        .prepare(`SELECT id FROM books WHERE groupId IN (${placeholders})`)
        .all(...groupIds) as Array<{ id: string }>
      deletedBookIds = bookRows.map((b) => b.id)
      if (deletedBookIds.length) {
        deleteBooks({ bookIds: deletedBookIds })
      }
    } else {
      d.prepare(`UPDATE books SET groupId = NULL WHERE groupId IN (${placeholders})`).run(...groupIds)
    }

    d.prepare(`DELETE FROM groups WHERE id IN (${placeholders})`).run(...groupIds)
    return { ok: true as const, deletedBookIds }
  })
  return tx()
}

export function moveBooks(input: { bookIds: string[]; groupId: string | null }) {
  const d = getDb()
  const bookIds = (input.bookIds ?? []).filter(Boolean)
  const groupId = input.groupId ?? null
  if (bookIds.length === 0) return { ok: true, unchanged: true }

  if (groupId) {
    const g = d.prepare(`SELECT id FROM groups WHERE id = ?`).get(groupId) as any
    if (!g) throw new Error('GROUP_NOT_FOUND')
  }

  const placeholders = bookIds.map(() => '?').join(',')
  d.prepare(`UPDATE books SET groupId = ?, updatedAt = ? WHERE id IN (${placeholders})`).run(groupId, nowMs(), ...bookIds)
  return { ok: true }
}

export function deleteBooks(input: { bookIds: string[] }) {
  const d = getDb()
  const bookIds = (input.bookIds ?? []).filter(Boolean)
  if (bookIds.length === 0) return { ok: true, unchanged: true, deletedCount: 0 }
  const placeholders = bookIds.map(() => '?').join(',')
  const tx = d.transaction(() => {
    // progress table doesn't have FK to books; clean manually
    d.prepare(`DELETE FROM progress WHERE bookId IN (${placeholders})`).run(...bookIds)
    // items are ON DELETE CASCADE via books FK
    const deleted = d.prepare(`DELETE FROM books WHERE id IN (${placeholders})`).run(...bookIds)
    return { ok: true, deletedCount: Number(deleted.changes ?? 0) }
  })
  return tx()
}