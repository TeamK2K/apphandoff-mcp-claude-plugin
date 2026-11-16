// Ticket, milestone and program titles beside HO/MS/PG ids in a reply (HO-22951, HO-22968). Pure, no `$`: the wiring in
// ./register.tsx collects the ids, asks the board, caches the answers and hands the drawing
// a map; this file only decides what text a reply is drawn with.
//
// A reply that says `HO-20342` draws as `[HO-20342 · Show ticket titles beside…](https://portal.apphandoff.com/HO-20342)`
// once the title is known; `MS-n` and `PG-n` the same (a program's `name` stands for its title). No dot leads the link.
// An id the Mac hook already linked (`[HO-n](https://portal.apphandoff.com/HO-n)`)
// gains the dot and the title inside its link text; an id in a fenced block, in inline code, in any other link
// or inside any URL is left as it was.

import { PORTAL } from './apphandoff-server'
import { type Info, oneLine, parseInfo, REF_NUM } from './ticket-views'

export { PORTAL }

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

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
/** A title's hover card (stage, status, claim) older than this is asked again when a reply names the id. */
export const HOVER_TTL_MS = 10 * 60 * 1000
/** After a failed lookup (not a not-found) nothing is asked for this long. */
export const RETRY_MS = 2 * 60 * 1000

/** A reply holding this word draws its ids as written, and the word itself is hidden; the next reply draws titles again. */
export const NO_HIGHLIGHT = 'no-hl-plz'

const NO_HIGHLIGHT_RUN = new RegExp(`[ \\t]*${escapeRegExp(NO_HIGHLIGHT)}[ \\t]*`, 'g')

export const wantsNoHighlight = (text: string): boolean => text.includes(NO_HIGHLIGHT)

/** The reply with every marker removed, and the space it leaves behind folded. */
export function stripNoHighlight(text: string): string {
  return text.replace(NO_HIGHLIGHT_RUN, (m) => (/^[ \t]/.test(m) && /[ \t]$/.test(m) ? ' ' : '')).replace(/^\n+/, '')
}

/** `HO-12`, `MS-3` or `PG-1` to its shortened title. */
export type Titles = Record<string, string>
/** `HO-12`, `MS-3` or `PG-1` to its hover card: the link's tooltip text, lines joined with `\n`. */
export type Hovers = Record<string, string>

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
  const words = oneLine(title)
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

/** A title as markdown link text: brackets, angle brackets and backslashes escaped, line breaks gone. */
export const escapeLinkText = (s: string) =>
  s
    .replace(/`/g, '') // a backtick would open a code span that swallows the link's `](url)`
    .replace(/\|/g, '/') // a pipe would split a table cell
    .replace(/\s+/g, ' ')
    .replace(/[\\[\]<>]/g, (c) => `\\${c}`) // `<` would open an autolink or raw HTML inside the text

// ── the rewrite ──────────────────────────────────────────────────────────

/** Cheap pre-check: a text with no `HO-`, `MS-` or `PG-` followed by a digit cannot change. */
export const mayHaveRefs = (text: string) => /(?:HO|MS|PG)-\d/.test(text)

// A link's text may hold escapes (`\[`, `\]`), which is how a title with brackets is drawn; a bare id right after `[` is a link's text, not prose.
const ANY = new RegExp(
  String.raw`(!?\[(?:\\.|[^\]\n\\])*\]\([^)\n]*\))|(?<![A-Za-z0-9_/.\-#@:=?&%~+[])((?:HO|MS|PG)-${REF_NUM})(?![A-Za-z0-9_]|-[A-Za-z0-9])`,
  'g',
)
const PORTAL_URL = new RegExp(`^<?${escapeRegExp(PORTAL)}((?:HO|MS|PG)-${REF_NUM})/?>?$`)

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

/**
 * The text with each id that has a title drawn as a portal link carrying it; the text itself when none has.
 * `suffixes` (ref to words, e.g. `● in progress`) are added after the title inside the link text.
 */
export function rewrite(text: string, titles: Titles, suffixes?: Record<string, string>): string {
  if (!mayHaveRefs(text)) return text
  return walk(text, (ref) => (titles[ref] && suffixes?.[ref] ? `${titles[ref]} · ${suffixes[ref]}` : titles[ref]), new Set())
}

/** Hover chips under one reply at most. */
export const MAX_CHIPS = 10

/** One chip under a reply: `HO-12 · In progress`, and the card its hover reveals, line by line. */
export type Chip = { ref: string; label: string; lines: string[] }

/**
 * Second lines of a hover card that are not a standing: who holds the ticket, a parent (`MS-3 …`, `PG-1 …`),
 * or the priority and size alone. A card with no stage or status has one of these there instead (see hoverCard).
 */
const NOT_STANDING = /^(?:Claimed by |Not claimed$|(?:HO|MS|PG)-\d|\S+ priority\b|size )/

/**
 * The chips a reply draws under it: one per id it names outside code (in order, once each, at most
 * `MAX_CHIPS`) that has a hover card. The label adds the card's standing (its second line's first
 * part: a ticket's stage, a milestone's status) when the card has one; a second line that is the
 * claim, a parent or the size is no standing.
 */
export function chipsFor(text: string, hovers: Hovers): Chip[] {
  const out: Chip[] = []
  for (const ref of refsIn(text)) {
    const card = hovers[ref]
    if (!card) continue
    // Each line cleaned of control bytes (a card stored by an earlier version may hold some); a line break such a card
    // already holds stays a line until the card is read again (HOVER_TTL_MS).
    const lines = card.split('\n').map(oneLine)
    const second = lines.length > 2 ? (lines[1] ?? '') : ''
    const stand = NOT_STANDING.test(second) ? '' : second.split(' · ')[0]?.trim()
    out.push({ ref, label: stand ? `${ref} · ${stand}` : ref, lines })
    if (out.length === MAX_CHIPS) break
  }
  return out
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

// ── the hover card ───────────────────────────────────────────────────────

const STAGE_WORDS: Record<string, string> = {
  backlog: 'Backlog',
  up_next: 'Up next',
  in_progress: 'In progress',
  validation: 'Validation',
  live: 'Live',
}

/** A board word (`up_next`, `in_progress`) as plain words. */
const words = (v: unknown): string | null => {
  const s = typeof v === 'string' ? oneLine(v) : ''
  return s !== '' ? (STAGE_WORDS[s] ?? s.replace(/_/g, ' ')) : null
}

/** A board string as one clean line, null when nothing is left. */
const line = (v: unknown): string | null => (typeof v === 'string' && oneLine(v) !== '' ? oneLine(v) : null)

/** One `MS-n name` / `PG-n name` line from a card's `milestone` or `program` field. */
function parentLine(v: unknown): string | null {
  if (!isRecord(v)) return null
  const ref = line(v.ref)
  const name = line(v.name) ?? line(v.title)
  return ref || name ? [ref, name].filter(Boolean).join(' ') : null
}

/**
 * The hover card of one `get` card: its whole card title (the board cuts a ticket's at 70
 * characters), then where it stands, who holds it and what it sits under, then `As of <asOf>`
 * (the card is a snapshot, refreshed when a later reply names the id). Null for no usable card.
 */
export function hoverCard(item: unknown, asOf: string): string | null {
  if (!isRecord(item)) return null
  // Every string of the card goes in as one clean line (a newline would forge a card line, an escape would garble the screen).
  const title = line(item.title) ?? line(item.name)
  if (title === null) return null
  const lines = [title]
  const kind = typeof item.kind === 'string' ? item.kind : typeof item.ref === 'string' && item.ref.startsWith('HO-') ? 'ticket' : null
  if (kind === 'ticket') {
    const stand = [words(item.stage), words(item.status)].filter(Boolean).join(' · ')
    const priority = line(item.priority)
    const size = line(item.size)
    const sized = [priority ? `${priority} priority` : null, size ? `size ${size}` : null].filter(Boolean).join(', ')
    if (stand || sized) lines.push([stand, sized].filter(Boolean).join(' · '))
    const claims = Array.isArray(item.claims) ? item.claims.flatMap((c) => line(c) ?? []) : []
    if (claims.length > 0) lines.push(`Claimed by ${claims.join(', ')}`)
    else if (item.stage !== 'live' && item.status !== 'closed') lines.push('Not claimed')
    const ms = parentLine(item.milestone)
    if (ms) lines.push(ms)
  } else {
    const stand = words(item.status) ?? words(item.state)
    if (stand) lines.push(stand)
    const pg = parentLine(item.program)
    if (pg) lines.push(pg)
  }
  lines.push(`As of ${asOf}`)
  return lines.join('\n')
}

/** The hover card of each card in a `get` answer that one of `asked` names. */
export function readHovers(json: unknown, asked: readonly string[], asOf: string): Hovers {
  if (!isRecord(json) || !Array.isArray(json.items)) return {}
  const want = new Set(asked)
  const out: Hovers = {}
  for (const item of json.items) {
    if (!isRecord(item) || typeof item.ref !== 'string') continue
    const ref = item.ref.trim().toUpperCase()
    if (!want.has(ref)) continue
    const card = hoverCard(item, asOf)
    if (card) out[ref] = card
  }
  return out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Nov 16 14:05` (24-hour, this computer's time zone): when a hover card was read. A card is kept 7 days, so the day is part of it. */
export function clockText(ms: number): string {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ── the cache ────────────────────────────────────────────────────────────

export type StoredTitle = { title: string | null; savedAt: number; hover?: string; info?: Info }

export const toStored = (title: string | null, now: number, hover?: string, info?: Info): StoredTitle => ({
  title,
  savedAt: now,
  ...(hover ? { hover } : {}),
  ...(info ? { info } : {}),
})

/** A cached entry still good at `now`, else null (missing, malformed, or past its expiry). */
export function fromStored(raw: unknown, now: number): StoredTitle | null {
  if (!isRecord(raw) || typeof raw.savedAt !== 'number') return null
  const title = typeof raw.title === 'string' && raw.title !== '' ? raw.title : null
  if (raw.title !== null && title === null) return null
  const age = now - raw.savedAt
  if (age > (title === null ? MISS_TTL_MS : HIT_TTL_MS)) return null
  if (title === null) return { title, savedAt: raw.savedAt }
  // An entry from before the structured record has no `info`: it loads as it was.
  const info = parseInfo(raw.info)
  return {
    title,
    savedAt: raw.savedAt,
    ...(typeof raw.hover === 'string' && raw.hover !== '' ? { hover: raw.hover } : {}),
    ...(info ? { info } : {}),
  }
}

/**
 * Whether a reply naming the id needs no lookup: a miss inside its day, or a title whose hover card
 * was read within `HOVER_TTL_MS` (stage, status and claim move faster than titles).
 */
export const isFresh = (entry: StoredTitle | null, now: number): boolean =>
  entry !== null && (entry.title === null || now - entry.savedAt <= HOVER_TTL_MS)

/** The drawing's map after adding `found`, the oldest dropped past the cap. A key in `found` moves to the newest end, so a ref just refreshed is not the next dropped. */
export function mergeTitles<T = string>(current: Record<string, T> | undefined, found: Record<string, T>): Record<string, T> {
  const kept = Object.fromEntries(Object.entries(current ?? {}).filter(([k]) => !(k in found)))
  const merged: Record<string, T> = { ...kept, ...found }
  const keys = Object.keys(merged)
  if (keys.length <= MAX_DRAWN) return merged
  return Object.fromEntries(keys.slice(keys.length - MAX_DRAWN).map((k) => [k, merged[k] as T]))
}
