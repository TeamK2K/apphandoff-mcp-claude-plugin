// Ticket views: what the plugin draws from the cards it has read, beyond a reply's link text.
// Pure, no `$`: ./register.tsx collects the ids, asks the board, keeps the answers in `$.state` and draws;
// this file decides the options, the structured record of a card, and every line of text the views show.
//
// Seven options, each its own toggle (`/hoview`), all on except `shelf`, `stage` and `chips` (defaultOptions):
//   program  a band above the composer: the latest program the chat touched, with its progress
//   shelf    the band's second row: the chat's tickets (watched first, then the latest mentioned)
//   mini     a floating mini program view (a pane drawn as a widget)
//   hint     the line under the composer names the ticket the chat holds, else the latest mentioned
//   toolrow  one dim line under an AppHandoff tool call's row naming what the call read or wrote
//   stage    the stage after the title in a reply's ticket links (off: it made every link loud)
//   chips    hover chips under a reply (off: they are noisy)

import { parseToolName } from './apphandoff-server'

export const OPTIONS_KEY = 'hoview-options'

export const OPTION_NAMES = ['program', 'shelf', 'mini', 'hint', 'toolrow', 'stage', 'chips'] as const
export type OptionName = (typeof OPTION_NAMES)[number]
export type Options = Record<OptionName, boolean>

const NOTES: Record<OptionName, string> = {
  program: 'band above the composer: the latest program and its progress',
  shelf: 'band above the composer: your tickets, with a card on hover',
  mini: 'floating mini program view (/hoview mini open)',
  hint: 'line under the composer: the ticket you hold, else the latest mentioned',
  toolrow: 'a dim line under each AppHandoff tool call: the ticket it names',
  stage: 'stage after the title in a reply\'s ticket links',
  chips: 'hover chips under a reply',
}

export const defaultOptions = (): Options => ({ program: true, shelf: false, mini: true, hint: true, toolrow: true, stage: false, chips: false })

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The number of an HO, MS or PG id: no leading zero, at most 9 digits. The one grammar every id check here (and in ./ticket-titles) is built from. */
export const REF_NUM = '[1-9]\\d{0,8}'
const REF_ANY = new RegExp(`^(?:HO|MS|PG)-${REF_NUM}$`)
const REF_TICKET = new RegExp(`^HO-${REF_NUM}$`)
const REF_TICKET_ANYCASE = new RegExp(REF_TICKET.source, 'i')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A board string as one plain line: control characters (an escape, a C1 byte, a newline, a tab) become spaces,
 * runs of whitespace fold, the ends are trimmed. Every title, claim, status and parent name goes through this
 * before a view draws it, so a card cannot garble the terminal or forge a line of a hover card.
 */
export const oneLine = (s: string): string =>
  s
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '') // zero-width and bidi controls: they hide or reorder text
    .replace(/\s+/g, ' ')
    .trim()

const str = (v: unknown): string | undefined => (typeof v === 'string' && oneLine(v) !== '' ? oneLine(v) : undefined)

/** The claims of a card as clean lines, none empty. */
const claimsOf = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((c) => (typeof c === 'string' && oneLine(c) !== '' ? [oneLine(c)] : [])) : [])

/** The stored (or drawn) options over the defaults: only a boolean for a known name counts. */
export function optionsFrom(raw: unknown): Options {
  const out = defaultOptions()
  if (!isRecord(raw)) return out
  for (const name of OPTION_NAMES) if (typeof raw[name] === 'boolean') out[name] = raw[name]
  return out
}

/**
 * What is stored after one `/hoview` switch: only the choices the person made (known names, booleans),
 * plus this one. A default left alone is never written, so a later default change reaches them.
 */
export function choicesWith(raw: unknown, name: OptionName, on: boolean): Partial<Options> {
  const out: Partial<Options> = {}
  if (isRecord(raw)) for (const n of OPTION_NAMES) if (typeof raw[n] === 'boolean') out[n] = raw[n]
  out[name] = on
  return out
}

export type HoviewCommand =
  | { action: 'list' }
  | { action: 'set'; name: OptionName; on: boolean | 'toggle' }
  | { action: 'mini'; open: boolean }
  | { action: 'invalid' }

/** `/hoview`, `/hoview <name|number> [on|off]`, `/hoview mini open|close`. */
export function parseHoview(args: string): HoviewCommand {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { action: 'list' }
  const first = words[0] as string
  const name = /^\d+$/.test(first) ? OPTION_NAMES[Number(first) - 1] : OPTION_NAMES.find((n) => n === first)
  if (!name || words.length > 2) return { action: 'invalid' }
  const arg = words[1]
  if (name === 'mini' && (arg === 'open' || arg === 'close')) return { action: 'mini', open: arg === 'open' }
  if (arg === undefined) return { action: 'set', name, on: 'toggle' }
  if (arg === 'on' || arg === 'off') return { action: 'set', name, on: arg === 'on' }
  return { action: 'invalid' }
}

export const HOVIEW_USAGE = 'usage: /hoview [<name|number> [on|off]] | /hoview mini open|close'

export function describeOptions(options: Options): string {
  const rows = OPTION_NAMES.map((n, i) => `${i + 1}. ${n.padEnd(8)} ${options[n] ? 'on ' : 'off'}  ${NOTES[n]}`)
  return ['Ticket views (APPHANDOFF_TICKET_TITLES=off turns all of them off):', ...rows, HOVIEW_USAGE].join('\n')
}

// ── the structured record of a card ──────────────────────────────────────

export type Parent = { ref: string; name: string }

/** What one `get` card said, kept whole enough to draw every view from it. `readAt`: when the board answered. */
export type Info = {
  kind: 'ticket' | 'milestone' | 'program'
  /** The full card title (a program's name). */
  title: string
  stage?: string
  status?: string
  /** A program's state. */
  state?: string
  priority?: string
  size?: string
  claims?: string[]
  milestone?: Parent
  program?: Parent
  /** A program's milestones by status. */
  counts?: Record<string, number>
  readAt: number
}
export type Infos = Record<string, Info>

const KINDS = ['ticket', 'milestone', 'program'] as const

function kindOf(item: Record<string, unknown>, ref: string): Info['kind'] | null {
  const k = KINDS.find((x) => x === item.kind)
  if (k) return k
  return ref.startsWith('HO-') ? 'ticket' : ref.startsWith('MS-') ? 'milestone' : ref.startsWith('PG-') ? 'program' : null
}

function parentOf(v: unknown): Parent | undefined {
  if (!isRecord(v)) return undefined
  const ref = str(v.ref)
  if (!ref) return undefined
  return { ref: ref.toUpperCase(), name: str(v.name) ?? str(v.title) ?? '' }
}

function countsOf(v: unknown): Record<string, number> | undefined {
  if (!isRecord(v)) return undefined
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[k] = n
  return Object.keys(out).length > 0 ? out : undefined
}

/** One `get` card as an Info; null for no usable card (no ref, no title). */
export function infoFrom(item: unknown, now: number): Info | null {
  if (!isRecord(item)) return null
  const ref = str(item.ref)?.toUpperCase()
  const title = str(item.title) ?? str(item.name)
  const kind = ref ? kindOf(item, ref) : null
  if (!ref || !title || !kind) return null
  const info: Info = { kind, title, readAt: now }
  const set = (k: 'stage' | 'status' | 'state' | 'priority' | 'size', v: unknown) => {
    const s = str(v)
    if (s) info[k] = s
  }
  set('stage', item.stage)
  set('status', item.status)
  set('state', item.state)
  set('priority', item.priority)
  set('size', item.size)
  const claims = claimsOf(item.claims)
  if (claims.length > 0) info.claims = claims
  const milestone = parentOf(item.milestone)
  if (milestone) info.milestone = milestone
  const program = parentOf(item.program)
  if (program) info.program = program
  const counts = countsOf(item.milestones)
  if (counts) info.counts = counts
  return info
}

/** The Info of each card in a `get` answer that one of `asked` names. */
export function readInfos(json: unknown, asked: readonly string[], now: number): Infos {
  if (!isRecord(json) || !Array.isArray(json.items)) return {}
  const want = new Set(asked)
  const out: Infos = {}
  for (const item of json.items) {
    const info = infoFrom(item, now)
    const ref = isRecord(item) ? str(item.ref)?.toUpperCase() : undefined
    if (info && ref && want.has(ref)) out[ref] = info
  }
  return out
}

/** An Info read back from the store: the shape checked, anything else dropped (an old entry has none). */
export function parseInfo(raw: unknown): Info | null {
  if (!isRecord(raw) || typeof raw.readAt !== 'number') return null
  const kind = KINDS.find((x) => x === raw.kind)
  const title = str(raw.title)
  if (!kind || !title) return null
  const info: Info = { kind, title, readAt: raw.readAt }
  for (const k of ['stage', 'status', 'state', 'priority', 'size'] as const) {
    const s = str(raw[k])
    if (s) info[k] = s
  }
  const claims = claimsOf(raw.claims)
  if (claims.length > 0) info.claims = claims
  const milestone = parentOf(raw.milestone)
  if (milestone) info.milestone = milestone
  const program = parentOf(raw.program)
  if (program) info.program = program
  const counts = countsOf(raw.counts)
  if (counts) info.counts = counts
  return info
}

// ── words and colors ─────────────────────────────────────────────────────

export const stageWord = (stage: string | undefined): string => (stage ? stage.replace(/_/g, ' ') : '')

const STAGE_COLORS: Record<string, string> = { in_progress: 'yellow', validation: 'yellow', up_next: 'cyan', backlog: 'gray' }
/** The color of a stage in a label (the milestone pane's): undefined for live or none. */
export const stageColor = (stage: string | undefined): string | undefined => (stage ? STAGE_COLORS[stage] : undefined)

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** `claimed by X, Y`, `unclaimed` for an open ticket nobody holds, '' where a claim means nothing (live, closed, not a ticket). */
export function claimText(info: Info | undefined): string {
  if (!info || info.kind !== 'ticket') return ''
  if (info.claims && info.claims.length > 0) return `claimed by ${info.claims.join(', ')}`
  return info.stage === 'live' || info.status === 'closed' ? '' : 'unclaimed'
}

/** The words after a title in a reply's link: a ticket's stage unless live, a milestone's status. Undefined for none. */
export function stageSuffix(info: Info | undefined): string | undefined {
  if (!info) return undefined
  if (info.kind === 'ticket' && info.stage && info.stage !== 'live') return `● ${stageWord(info.stage)}`
  if (info.kind === 'milestone' && info.status) return `● ${info.status}`
  return undefined
}

export function suffixes(infos: Infos | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [ref, info] of Object.entries(infos ?? {})) {
    const s = stageSuffix(info)
    if (s) out[ref] = s
  }
  return out
}

// ── what the chat touched ────────────────────────────────────────────────

/** What the views know about the chat: the ids it named latest first, its watched tickets, the leases it holds. */
export type Focus = { recent: string[]; watched: string[]; held: Record<string, number> }
export const MAX_RECENT = 20

export const emptyFocus = (): Focus => ({ recent: [], watched: [], held: {} })

/** Store key prefix of a chat's named ids (never `session:` or `ticket-title:`, whose sweeps are their own). */
export const FOCUS_PREFIX = 'ticket-focus:'
/** A chat's named ids are kept this long after it last named one. */
export const FOCUS_TTL_MS = 14 * 24 * 60 * 60 * 1000

/** The board this chat's own AppHandoff calls used, kept with its named ids so /pg and the band's program button survive a reload. */
export type FocusBoard = { called: boolean; projects: string[] }

export const focusToStored = (recent: readonly string[], now: number, board?: FocusBoard) => ({
  recent: [...recent].slice(0, MAX_RECENT),
  savedAt: now,
  ...(board?.called ? { board: { called: true, projects: board.projects.filter((p) => typeof p === 'string' && UUID.test(p)).slice(0, 5) } } : {}),
})

/** The board a stored entry kept, else null (none kept, malformed, or past `FOCUS_TTL_MS`). */
export function boardFromStored(raw: unknown, now: number): FocusBoard | null {
  if (focusFromStored(raw, now) === null) return null
  const b = (raw as { board?: unknown }).board
  if (typeof b !== 'object' || b === null) return null
  const r = b as { called?: unknown; projects?: unknown }
  if (r.called !== true || !Array.isArray(r.projects)) return null
  // A project id is sent on every /pg read: only a UUID (the form the live ids pass) comes back from the store.
  return { called: true, projects: r.projects.filter((p): p is string => typeof p === 'string' && UUID.test(p)).map((p) => p.toLowerCase()).slice(0, 5) }
}

/** The named ids a stored entry keeps, else null (malformed or past `FOCUS_TTL_MS`). */
export function focusFromStored(raw: unknown, now: number): string[] | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as { recent?: unknown; savedAt?: unknown }
  if (typeof r.savedAt !== 'number' || now - r.savedAt > FOCUS_TTL_MS || !Array.isArray(r.recent)) return null
  return r.recent.filter((x): x is string => typeof x === 'string' && REF_ANY.test(x)).slice(0, MAX_RECENT)
}

/** The focus after `refs` were named, in the order the text names them: the last one named is the latest. */
export function withMentions(cur: Focus | undefined, refs: readonly string[]): Focus {
  const base = cur ?? emptyFocus()
  const newest = [...new Set(refs)].reverse()
  return { ...base, recent: [...newest, ...base.recent.filter((r) => !newest.includes(r))].slice(0, MAX_RECENT) }
}

export const withWatched = (cur: Focus | undefined, watched: string[], held: Record<string, number>): Focus => ({ ...(cur ?? emptyFocus()), watched, held })

/** The HO ids of the inbox's watched tickets (an id the chat named by UUID counts once its number is known), and the leases among them. */
export function watchedRefs(list: readonly { ref: string; number: number | null; heldUntil?: number | null }[]): { watched: string[]; held: Record<string, number> } {
  const watched: string[] = []
  const held: Record<string, number> = {}
  for (const w of list) {
    const ref = REF_TICKET_ANYCASE.test(w.ref) ? w.ref.toUpperCase() : w.number ? `HO-${w.number}` : null
    if (!ref || watched.includes(ref)) continue
    watched.push(ref)
    if (typeof w.heldUntil === 'number' && w.heldUntil > 0) held[ref] = w.heldUntil
  }
  return { watched, held }
}

export const isTicketRef = (r: string) => REF_TICKET.test(r)

/** The latest program or milestone the chat touched: the first of `recent` that is one, or whose card names one. */
export function programFocus(recent: readonly string[], infos: Infos | undefined): { pg?: string; ms?: string } {
  for (const ref of recent) {
    if (ref.startsWith('PG-')) return { pg: ref }
    const ms = ref.startsWith('MS-') ? ref : isTicketRef(ref) ? infos?.[ref]?.milestone?.ref : undefined
    if (!ms) continue
    const pg = infos?.[ms]?.program?.ref
    return pg ? { pg, ms } : { ms }
  }
  return {}
}

/** Refs the cards named that the views also need: a ticket's milestone, a milestone's program. */
export function impliedRefs(refs: readonly string[], infos: Infos): string[] {
  const out = new Set<string>()
  for (const ref of refs) {
    const info = infos[ref]
    const next = info?.kind === 'ticket' ? info.milestone?.ref : info?.kind === 'milestone' ? info.program?.ref : undefined
    if (next) out.add(next)
  }
  return [...out]
}

/** A program's milestone counts: done, moving (building), all that count (not dropped). Null with no counts. */
export function programTotals(info: Info | undefined): { done: number; building: number; total: number } | null {
  if (!info?.counts) return null
  const total = Object.entries(info.counts).reduce((n, [status, c]) => (status === 'dropped' ? n : n + c), 0)
  if (total === 0) return null
  // A program card counts its milestones `open` / `closed` / `dropped`; a milestone list by status names `done`.
  return { done: (info.counts.closed ?? 0) + (info.counts.done ?? 0), building: info.counts.building ?? 0, total }
}

/** `PG-120 · 27/34 done` (just the id until the program's card is read): no name, no milestone, no tickets in the band. */
export function programLabel(ref: string, info: Info | undefined): string {
  const t = programTotals(info)
  return t ? `${ref} · ${t.done}/${t.total} done` : ref
}

/** The shelf's tickets: the watched first, then the latest mentioned, HO ids only, once each. */
export function shelfRefs(watched: readonly string[], recent: readonly string[], max = 6): string[] {
  return [...new Set([...watched, ...recent].filter(isTicketRef))].slice(0, max)
}

/** One shelf label: `HO-12 · in progress`. */
export const shelfLabel = (ref: string, info: Info | undefined): string => (info?.stage ? `${ref} · ${stageWord(info.stage)}` : ref)

/**
 * The ticket the composer's hint line names: the one the chat holds a live lease on (the one held longest
 * still), else the latest ticket it named. Null when there is none.
 */
export function hintTarget(focus: Focus | undefined, now: number): { ref: string; held: boolean } | null {
  const held = Object.entries(focus?.held ?? {})
    .filter(([ref, until]) => until > now && isTicketRef(ref))
    .sort((a, b) => b[1] - a[1])[0]?.[0]
  if (held) return { ref: held, held: true }
  const ref = focus?.recent.find(isTicketRef)
  return ref ? { ref, held: false } : null
}

/** The text after the composer's hint line (`HO-12 · in progress · claimed by you`); null when there is no ticket. */
export function hintTail(focus: Focus | undefined, infos: Infos | undefined, now: number): string | null {
  const target = hintTarget(focus, now)
  if (!target) return null
  const info = infos?.[target.ref]
  return [target.ref, stageWord(info?.stage), target.held ? 'claimed by you' : claimText(info)].filter(Boolean).join(' · ')
}

// ── an AppHandoff tool call's row ────────────────────────────────────────

/** The tools whose rows get a line. */
export const TOOLROW_TOOLS = ['ticket', 'get', 'plan', 'message'] as const
/** The tools that write what a card shows: their landing marks the refs they name stale. */
export const isWriteTool = (tool: string) => tool === 'ticket' || tool === 'plan'

/** The AppHandoff tool (one of TOOLROW_TOOLS) a tool name stands for on a learned connection, else null. */
export function appHandoffTool(name: string, servers: readonly string[]): string | null {
  const parsed = typeof name === 'string' ? parseToolName(name) : null
  return parsed && servers.includes(parsed.server) && (TOOLROW_TOOLS as readonly string[]).includes(parsed.tool) ? parsed.tool : null
}

const REF = new RegExp(REF_ANY.source, 'i')
const REF_KEYS = ['ref', 'refs', 'milestone', 'program', 'milestone_id', 'program_id'] as const

/** The ids a call's input names: `ref`, `refs`, and the same under `op`, `ops[]` and `filter`. Upper case, once each. */
export function refsOfInput(input: unknown): string[] {
  const out = new Set<string>()
  const add = (v: unknown) => {
    if (typeof v === 'string' && REF.test(v.trim())) out.add(v.trim().toUpperCase())
    else if (Array.isArray(v)) v.forEach(add)
  }
  const scan = (o: unknown) => {
    if (isRecord(o)) for (const k of REF_KEYS) add(o[k])
  }
  if (!isRecord(input)) return []
  scan(input)
  scan(input.op)
  if (Array.isArray(input.ops)) input.ops.forEach(scan)
  scan(input.filter)
  return [...out]
}

/** One line under a tool row: `HO-n · title · stage · claim`; null while the card is unknown. */
export function toolLine(ref: string, info: Info | undefined): string | null {
  if (!info) return null
  const rest = info.kind === 'ticket' ? [stageWord(info.stage), claimText(info)] : [info.kind === 'milestone' ? info.status : info.state]
  return [ref, short(info.title, 60), ...rest].filter(Boolean).join(' · ')
}

export const TOOL_LINES = 3

export function toolLines(refs: readonly string[], infos: Infos | undefined): string[] {
  const lines = refs.slice(0, TOOL_LINES).flatMap((r) => toolLine(r, infos?.[r]) ?? [])
  return refs.length > TOOL_LINES && lines.length > 0 ? [...lines, `+${refs.length - TOOL_LINES} more`] : lines
}

/** The card lines a shelf entry reveals on hover: the stored hover card's lines (each cleaned, a stored card may predate that), else the label. */
export const cardLines = (card: string | undefined, fallback: string): string[] => (card ? card.split('\n').map(oneLine) : [fallback])
