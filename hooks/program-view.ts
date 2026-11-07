// The /pg program view (HO-24860): everything it decides, pure — no `$`, no I/O. ./register.tsx reads
// the board and draws; this file turns what the board said into the numbers and lists the drawing
// shows, and picks which board (server and project) the chat's own AppHandoff calls point at.

export type Pg = { ref: string; name: string; headline?: string }
export type Tk = { ref: string; title: string; stage: string; status: string; type?: string }
export type Ms = {
  ref: string
  title: string
  status: string
  shipped: number
  /** Tickets in progress (in_progress or validation). */
  active: number
  queued: number
  total: number
  decisions: number
  /** A milestone approval waits on a person. */
  approval: boolean
}

/** A milestone row as the drawing gets it (plain data). `percent` is null when the milestone has no tickets. */
export type Row = { ref: string; title: string; status: string; percent: number | null; approval: boolean }

/** Milestone statuses that are still moving; everything else is finished (done, dropped). */
export const ACTIVE = ['building', 'approved', 'draft']
const STATUSES = [...ACTIVE, 'done', 'dropped']
/** Ticket stages that are open; any other stage is shipped. */
export const OPEN_STAGES = ['backlog', 'up_next', 'in_progress', 'validation']
const MOVING_STAGES = ['in_progress', 'validation']
/** Open tickets, the order the milestone list shows them in. */
const STAGE_RANK = ['validation', 'in_progress', 'up_next', 'backlog']

export const PORTAL = 'https://portal.apphandoff.com/'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

export const isProgramRef = (v: unknown): v is string => typeof v === 'string' && /^PG-\d+$/.test(v)
export const isMilestoneRef = (v: unknown): v is string => typeof v === 'string' && /^MS-\d+$/.test(v)
export const isTicketRef = (v: unknown): v is string => typeof v === 'string' && /^HO-\d+$/.test(v)

// ── reading the board's answers ──────────────────────────────────────────

/** One `find` program item, or null when it names no PG-n. */
export function programFrom(item: unknown): Pg | null {
  if (!isRecord(item) || !isProgramRef(item.ref)) return null
  const headline = text(item.headline)
  return { ref: item.ref, name: text(item.name) ?? item.ref, ...(headline && { headline }) }
}

/** One `find` ticket item, or null when it names no HO-n. */
export function ticketFrom(item: unknown): Tk | null {
  if (!isRecord(item) || !isTicketRef(item.ref)) return null
  const type = text(item.type)
  return { ref: item.ref, title: text(item.title) ?? item.ref, stage: text(item.stage) ?? '', status: text(item.status) ?? '', ...(type && { type }) }
}

/** The ticket counts a milestone item carries (`tickets: {open, shipped, ...}`). */
const countsOf = (item: Record<string, unknown>): Record<string, number> => {
  const out: Record<string, number> = {}
  if (isRecord(item.tickets)) for (const [k, v] of Object.entries(item.tickets)) out[k] = num(v)
  return out
}

/**
 * The milestone whose open tickets are worth reading, by its MS number: only one still moving (building,
 * approved, draft) with open tickets. A done or dropped milestone is never read for tickets.
 */
export function ticketsToRead(item: unknown): string | null {
  if (!isRecord(item) || !isMilestoneRef(item.ref)) return null
  return ACTIVE.includes(text(item.status) ?? '') && (countsOf(item).open ?? 0) > 0 ? item.ref : null
}

/** One milestone: its counts from the item, the moving and decision counts from its open tickets, the approval flag from `pending`. */
export function milestoneFrom(item: unknown, open: readonly Tk[], pending: ReadonlySet<string>): Ms | null {
  if (!isRecord(item) || !isMilestoneRef(item.ref)) return null
  const counts = countsOf(item)
  // The board counts {open, shipped, cancelled}: a cancelled ticket is neither to do nor done.
  const shipped = counts.shipped ?? 0
  const total = (counts.open ?? 0) + shipped
  const active = open.filter((k) => MOVING_STAGES.includes(k.stage)).length
  return {
    ref: item.ref,
    title: text(item.title) ?? item.ref,
    status: text(item.status) ?? '',
    shipped,
    active,
    queued: Math.max(0, total - shipped - active),
    total,
    decisions: open.filter((k) => k.type === 'decision_needed').length,
    approval: pending.has(item.ref),
  }
}

/** Only a link on the portal is ever drawn as one. */
export function portalUrl(url: unknown): string | null {
  const u = text(url)
  return u?.startsWith(PORTAL) ? u : null
}

/** A ticket's page on the portal; null for anything that is not HO-n. */
export const ticketUrl = (ref: unknown): string | null => (isTicketRef(ref) ? `${PORTAL}${ref}` : null)

/** The milestones with a proposal waiting on a person, and the portal page of each milestone approval. */
export function proposalsFrom(items: readonly unknown[]): { pending: Set<string>; urls: Map<string, string> } {
  const pending = new Set<string>()
  const urls = new Map<string, string>()
  for (const p of items) {
    if (!isRecord(p) || !isRecord(p.target) || !isMilestoneRef(p.target.ref)) continue
    pending.add(p.target.ref)
    const url = portalUrl(p.portal_url)
    if (p.kind === 'milestone_approve' && url) urls.set(p.target.ref, url)
  }
  return { pending, urls }
}

// ── numbers and lists ────────────────────────────────────────────────────

export const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 0)

/** "just now", "42s ago", "3m ago". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 10 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}

/** `fn` over every item, at most `limit` at a time; the results in the items' order. The first failure rejects and starts no more. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < items.length) {
      const at = next++
      try {
        out[at] = await fn(items[at] as T)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

export type Totals = { shipped: number; active: number; queued: number; total: number; decisions: number; percent: number }

/** The program's totals: dropped milestones do not count. */
export function totals(milestones: readonly Ms[]): Totals {
  const counted = milestones.filter((m) => m.status !== 'dropped')
  const sum = (k: 'shipped' | 'active' | 'queued' | 'total' | 'decisions') => counted.reduce((n, m) => n + m[k], 0)
  const shipped = sum('shipped')
  const total = sum('total')
  return { shipped, active: sum('active'), queued: sum('queued'), total, decisions: sum('decisions'), percent: pct(shipped, total) }
}

/**
 * The widths (whole percents of the bar) of the shipped and moving segments. Whole percents only, a
 * segment with tickets at least 1 wide, and together never past 100, so the bar never overflows its box.
 */
export function barWidths(shipped: number, active: number, total: number): { shipped: number; active: number } {
  if (total <= 0) return { shipped: 0, active: 0 }
  const seg = (n: number) => (n > 0 ? Math.max(1, Math.round((n / total) * 100)) : 0)
  const s = Math.min(100, seg(shipped))
  return { shipped: s, active: Math.min(100 - s, seg(active)) }
}

/** By status (moving first), then the furthest along first; a tie keeps the board's order. */
export function sortMilestones(milestones: readonly Ms[]): Ms[] {
  const rank = (m: Ms) => {
    const at = STATUSES.indexOf(m.status)
    return at < 0 ? STATUSES.length : at
  }
  return milestones
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m) - rank(b.m) || pct(b.m.shipped, b.m.total) - pct(a.m.shipped, a.m.total) || a.i - b.i)
    .map(({ m }) => m)
}

/** The milestones still moving, and the finished (done, dropped, anything else), each sorted. */
export function splitMilestones(milestones: readonly Ms[]): { inFlight: Ms[]; finished: Ms[] } {
  return {
    inFlight: sortMilestones(milestones.filter((m) => ACTIVE.includes(m.status))),
    finished: sortMilestones(milestones.filter((m) => !ACTIVE.includes(m.status))),
  }
}

export const rowOf = (m: Ms): Row => ({
  ref: m.ref,
  title: m.title,
  status: m.status,
  percent: m.total > 0 ? pct(m.shipped, m.total) : null,
  approval: m.approval,
})

/** A milestone's tickets: the open ones furthest along first, and the shipped. */
export function splitTickets(tickets: readonly Tk[]): { open: Tk[]; shipped: Tk[] } {
  const rank = (t: Tk) => STAGE_RANK.indexOf(t.stage)
  return {
    open: tickets.filter((t) => OPEN_STAGES.includes(t.stage)).sort((a, b) => rank(a) - rank(b)),
    shipped: tickets.filter((t) => !OPEN_STAGES.includes(t.stage)),
  }
}

/** What the drawing's client module posts, validated: a program to re-read or a milestone to open. */
export function messageFrom(data: unknown): { refresh?: string; open?: string } {
  if (!isRecord(data)) return {}
  return { ...(isProgramRef(data.refresh) && { refresh: data.refresh }), ...(isMilestoneRef(data.open) && { open: data.open }) }
}

// ── which board ──────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PROJECTS_KEPT = 10

const lowerUuid = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v.trim()) ? v.trim().toLowerCase() : null)

/** The learned AppHandoff connection a tool name (`mcp__<server>__<tool>`) belongs to, else null. */
export function serverOfTool(tool: string, servers: readonly string[]): string | null {
  const name = /^mcp__(.+?)__(.+)$/.exec(tool)
  return name?.[1] && servers.includes(name[1]) ? name[1] : null
}

/**
 * The project one finished AppHandoff call used: the `project_id` it was sent, else the one its answer
 * names. Null for a failed call, a call on another server, and a call that named none.
 */
export function projectOfCall(call: { tool: string; args: Record<string, unknown>; text?: string; isError: boolean }, servers: readonly string[]): string | null {
  if (call.isError || !serverOfTool(call.tool, servers)) return null
  const sent = lowerUuid(call.args.project_id)
  if (sent) return sent
  const start = (call.text ?? '').search(/[[{]/)
  if (start < 0) return null
  try {
    const json: unknown = JSON.parse((call.text ?? '').slice(start))
    if (!isRecord(json)) return null
    return lowerUuid(json.project_id) ?? (isRecord(json.project) ? lowerUuid(json.project.id) : null)
  } catch {
    return null
  }
}

/** The projects the chat's calls used, the most recent first, each once. */
export function rememberProject(projects: readonly string[], id: string | null): string[] {
  return id ? [id, ...projects.filter((p) => p !== id)].slice(0, PROJECTS_KEPT) : [...projects]
}

export type BoardPick =
  | { kind: 'none' }
  | { kind: 'ambiguous'; servers: string[] }
  | { kind: 'ok'; server: string; project: string | null; key: string }

/**
 * Which board /pg reads: the one AppHandoff connection the chat has used and the project its calls used
 * most recently. With no project named (the chat's calls took the connection's own), none is sent and the
 * connection resolves it as it did for the chat. Nothing to read when the add-on is off, or when this chat
 * has made no AppHandoff call yet (a connection restored from an earlier run does not count).
 */
export function pickBoard(servers: readonly string[], projects: readonly string[], chatCalled = true, off = false): BoardPick {
  if (off || !chatCalled || servers.length === 0) return { kind: 'none' }
  const server = servers[0]
  if (servers.length > 1 || server === undefined) return { kind: 'ambiguous', servers: [...servers] }
  const project = projects[0] ?? null
  return { kind: 'ok', server, project, key: `${server}|${project ?? ''}` }
}
