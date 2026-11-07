// Ticket, milestone and program titles beside HO/MS/PG ids in a reply (HO-22951, HO-22968). Pure, no `$`: the wiring in
// ./register.tsx collects the ids, asks the board, caches the answers and hands the drawing
// a map; this file only decides what text a reply is drawn with.
//
// A reply that says `HO-20342` draws as `[HO-20342 · Show ticket titles beside…](https://portal.apphandoff.com/HO-20342)`
// once the title is known; `MS-n` and `PG-n` the same (a program's `name` stands for its title). No dot leads the link.
// An id the Mac hook already linked (`[HO-n](https://portal.apphandoff.com/HO-n)`)
// gains the dot and the title inside its link text; an id in a fenced block, in inline code, in any other link
// or inside any URL is left as it was.

export const PORTAL = 'https://portal.apphandoff.com/'

/** Ids per board `get` (the tool takes at most 10 `refs`). */
export const BATCH = 10
/** Ids looked up for one reply at most: the rest draw as they are. */
export const MAX_LOOKUPS_PER_REPLY = 50
/** Titles kept in the drawing's state (oldest dropped first). */
export const MAX_DRAWN = 400

export const STORE_PREFIX = 'ticket-title:'
/** A title found is kept 7 days (titles change rarely); a ref the board did not answer, 1 day. */
export const HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MISS_TTL_MS = 24 * 60 * 60 * 1000
/** After a failed lookup (not a not-found) nothing is asked for this long. */
export const RETRY_MS = 2 * 60 * 1000

/** A reply holding this word draws its ids as written, and the word itself is hidden; the next reply draws titles again. */
export const NO_HIGHLIGHT = 'no-hl-plz'

export const wantsNoHighlight = (text: string): boolean => text.includes(NO_HIGHLIGHT)

/** The reply with every marker removed, and the space it leaves behind folded. */
export function stripNoHighlight(text: string): string {
  return text.replace(/[ \t]*no-hl-plz[ \t]*/g, (m) => (/^[ \t]/.test(m) && /[ \t]$/.test(m) ? ' ' : '')).replace(/^\n+/, '')
}

/** `HO-12`, `MS-3` or `PG-1` to its shortened title. */
export type Titles = Record<string, string>

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Whether a failed `get` says the refs are gone (not a fault worth retrying), in the inbox's words. */
export const isGone = (text: string) => /TICKET_NOT_FOUND|ENTITY_NOT_FOUND|No ticket resolved/i.test(text)

// ── the title ────────────────────────────────────────────────────────────

const MAX_WORDS = 4
const MAX_CHARS = 40

/**
 * The first ~4 words (at most 40 characters) of a title, cut on a word boundary with an ellipsis
 * when something was left out. A title the board already cut with `…` counts as cut. Empty when
 * the title has no words.
 */
export function shortTitle(title: string): string {
  const cutAlready = /[…]\s*$/.test(title) || /\.\.\.\s*$/.test(title)
  const words = title
    .replace(/`/g, '') // dropped by escapeLinkText too; a title of backticks alone has no words
    .replace(/(…|\.\.\.)\s*$/, '')
    .split(/\s+/)
    .filter((w) => w !== '')
  if (words.length === 0) return ''
  const kept: string[] = []
  let length = 0
  for (const word of words.slice(0, MAX_WORDS)) {
    const next = length + (kept.length > 0 ? 1 : 0) + word.length
    if (next > MAX_CHARS) break
    kept.push(word)
    length = next
  }
  // A first word longer than the limit: cut it hard rather than draw nothing.
  if (kept.length === 0) return `${(words[0] ?? '').slice(0, MAX_CHARS - 1)}…`
  return kept.length < words.length || cutAlready ? `${kept.join(' ')}…` : kept.join(' ')
}

/** A title as markdown link text: brackets and backslashes escaped, line breaks gone. */
export const escapeLinkText = (s: string) =>
  s
    .replace(/`/g, '') // a backtick would open a code span that swallows the link's `](url)`
    .replace(/\|/g, '/') // a pipe would split a table cell
    .replace(/\s+/g, ' ')
    .replace(/[\\[\]]/g, (c) => `\\${c}`)

// ── the rewrite ──────────────────────────────────────────────────────────

/** Cheap pre-check: a text with no `HO-`, `MS-` or `PG-` followed by a digit cannot change. */
export const mayHaveRefs = (text: string) => /(?:HO|MS|PG)-\d/.test(text)

// A link's text may hold escapes (`\[`, `\]`), which is how a title with brackets is drawn; a bare id right after `[` is a link's text, not prose.
const ANY = /(!?\[(?:\\.|[^\]\n\\])*\]\([^)\n]*\))|(?<![A-Za-z0-9_/.\-#@:=?&%~+[])((?:HO|MS|PG)-[1-9]\d{0,8})(?![A-Za-z0-9_]|-[A-Za-z0-9])/g
const PORTAL_URL = /^<?https:\/\/portal\.apphandoff\.com\/((?:HO|MS|PG)-[1-9]\d{0,8})\/?>?$/

/** One `[text](url "title")`: its text, and the url without its optional title. */
function parseLink(link: string): { text: string; url: string } | null {
  const m = /^\[((?:\\.|[^\]\n\\])*)\]\(\s*(<[^>\n]*>|[^\s)]*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)$/.exec(link)
  return m ? { text: m[1] ?? '', url: m[2] ?? '' } : null
}

const linkOf = (ref: string, title: string) => `[${ref} · ${escapeLinkText(title)}](${PORTAL}${ref})`

/**
 * Walks the prose of a text (never a fenced block, never inline code), calling `titleOf` for each
 * id that may be given a title: a bare `HO-n`, `MS-n` or `PG-n`, or one portal link whose text is exactly that id.
 * Answers the rewritten text and the ids met, in order, once each.
 */
function scanProse(prose: string, titleOf: (ref: string) => string | undefined, refs: Set<string>): string {
  return prose.replace(ANY, (whole, link: string | undefined, bare: string | undefined) => {
    if (link !== undefined) {
      const parsed = parseLink(link)
      const ref = parsed ? PORTAL_URL.exec(parsed.url)?.[1] : undefined
      // Only the Mac hook's output (`[HO-n](portal/HO-n)`) takes a title; every other link is left whole.
      if (!parsed || !ref || parsed.text !== ref) return whole
      refs.add(ref)
      const title = titleOf(ref)
      return title ? linkOf(ref, title) : whole
    }
    const ref = bare as string
    refs.add(ref)
    const title = titleOf(ref)
    return title ? linkOf(ref, title) : whole
  })
}

/** Splits a prose block into inline-code spans (left alone) and the text between them. */
function mapOutsideInlineCode(block: string, fn: (prose: string) => string): string {
  let out = ''
  let plain = ''
  let i = 0
  while (i < block.length) {
    if (block[i] !== '`') {
      plain += block[i]
      i++
      continue
    }
    let run = i
    while (block[run] === '`') run++
    const ticks = run - i
    // The span closes at the next run of exactly as many backticks; with none, the ticks are plain text.
    let close = -1
    for (let j = run; j < block.length; ) {
      if (block[j] !== '`') {
        j++
        continue
      }
      let end = j
      while (block[end] === '`') end++
      if (end - j === ticks) {
        close = j
        break
      }
      j = end
    }
    if (close === -1) {
      plain += block.slice(i, run)
      i = run
      continue
    }
    out += fn(plain)
    plain = ''
    out += block.slice(i, close + ticks)
    i = close + ticks
  }
  return out + fn(plain)
}

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/

function walk(text: string, titleOf: (ref: string) => string | undefined, refs: Set<string>): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fence: { char: string; length: number } | null = null
  let prose: string[] = []
  const flush = () => {
    if (prose.length === 0) return
    out.push(mapOutsideInlineCode(prose.join('\n'), (p) => scanProse(p, titleOf, refs)))
    prose = []
  }
  // An indented code block: 4+ spaces or a tab, opening after a blank line (or at the start) and running
  // while lines stay indented (blank lines between them included). A list item's indented paragraph
  // after a blank line is taken for code too: its ids stay as written, never a wrong link.
  let blankBefore = true
  let indented = false
  for (const line of lines) {
    const m = FENCE.exec(line)
    if (fence) {
      out.push(line)
      const closes = m && m[2]?.[0] === fence.char && (m[2]?.length ?? 0) >= fence.length && (m[3] ?? '').trim() === ''
      if (closes) {
        fence = null
        blankBefore = true
      }
      continue
    }
    const blank = line.trim() === ''
    if (!blank && /^( {4}|\t)/.test(line) && (blankBefore || indented)) {
      flush()
      out.push(line)
      indented = true
      blankBefore = false
      continue
    }
    if (!blank) indented = false
    blankBefore = blank
    // A backtick fence's info string holds no backtick (else it is inline code on one line).
    if (m && m[2] && !(m[2][0] === '`' && (m[3] ?? '').includes('`'))) {
      flush()
      out.push(line)
      fence = { char: m[2][0] ?? '`', length: m[2].length }
      continue
    }
    prose.push(line)
  }
  flush()
  return out.join('\n')
}

/** The HO, MS and PG ids a text names outside code, in order, once each. */
export function refsIn(text: string): string[] {
  if (!mayHaveRefs(text)) return []
  const refs = new Set<string>()
  walk(text, () => undefined, refs)
  return [...refs]
}

/** The text with each id that has a title drawn as a portal link carrying it; the text itself when none has. */
export function rewrite(text: string, titles: Titles): string {
  if (!mayHaveRefs(text)) return text
  return walk(text, (ref) => titles[ref], new Set())
}

/** The reply's ids that still need asking: no title known, not asked about, at most the per-reply cap. */
export function unknownRefs(refs: readonly string[], known: { has: (ref: string) => boolean }, inFlight: { has: (ref: string) => boolean }): string[] {
  return refs.filter((r) => !known.has(r) && !inFlight.has(r)).slice(0, MAX_LOOKUPS_PER_REPLY)
}

export function batches<T>(items: readonly T[], size = BATCH): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** `get {refs, view: 'card'}`: the board call for one batch (at most 10 refs). */
export const lookupArgs = (refs: readonly string[]) => ({ refs: [...refs], view: 'card' })

/** Whether a JSON body is a `get` answer: `{items: [...]}`. */
export const isGetAnswer = (json: unknown) => isRecord(json) && Array.isArray(json.items)

/**
 * What a `get` answer says about the refs asked: a title (shortened) for each card that came
 * back with one (a program's `name` where it has no `title`), `null` for each ref asked that came
 * back as no card at all (not found, another project, no access). Null when the body is not an answer.
 */
export function readAnswer(json: unknown, asked: readonly string[]): Record<string, string | null> | null {
  if (!isRecord(json) || !Array.isArray(json.items)) return null
  const out: Record<string, string | null> = Object.fromEntries(asked.map((r) => [r, null]))
  for (const item of json.items) {
    if (!isRecord(item) || typeof item.ref !== 'string') continue
    const raw = typeof item.title === 'string' ? item.title : typeof item.name === 'string' ? item.name : null
    if (raw === null) continue
    const ref = item.ref.trim().toUpperCase()
    if (!(ref in out)) continue
    const title = shortTitle(raw)
    if (title !== '') out[ref] = title
  }
  return out
}

// ── the cache ────────────────────────────────────────────────────────────

export type StoredTitle = { title: string | null; savedAt: number }

export const toStored = (title: string | null, now: number): StoredTitle => ({ title, savedAt: now })

/** A cached entry still good at `now`, else null (missing, malformed, or past its expiry). */
export function fromStored(raw: unknown, now: number): StoredTitle | null {
  if (!isRecord(raw) || typeof raw.savedAt !== 'number') return null
  const title = typeof raw.title === 'string' && raw.title !== '' ? raw.title : null
  if (raw.title !== null && title === null) return null
  const age = now - raw.savedAt
  return age > (title === null ? MISS_TTL_MS : HIT_TTL_MS) ? null : { title, savedAt: raw.savedAt }
}

/** The drawing's map after adding `found`, the oldest dropped past the cap. */
export function mergeTitles(current: Titles | undefined, found: Titles): Titles {
  const merged = { ...current, ...found }
  const keys = Object.keys(merged)
  if (keys.length <= MAX_DRAWN) return merged
  return Object.fromEntries(keys.slice(keys.length - MAX_DRAWN).map((k) => [k, merged[k] as string]))
}
