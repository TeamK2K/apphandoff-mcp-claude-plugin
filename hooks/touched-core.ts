// AppHandoff for Claude Code — the touched panes' decision logic (HO-17539).
// Pure: no `$`, no I/O — touched.tsx feeds it what the engine said and draws
// what it returns, so every rule is unit-tested under bun (touched-core.spec.ts).
//
// The chat's own AppHandoff tool calls, read from transcript rows, teach which
// milestones (MS-n) and tickets (HO-n) this chat touched, their latest known
// status, and any milestone move waiting on a human (an `awaiting_approval` answer).
// Which server is AppHandoff is decided in ./apphandoff-server.ts (shared with
// the inbox).

import { isAppHandoffCall, mayBeAppHandoff, parseToolName } from './apphandoff-server'
// The inbox's backoff rules, reused as they are: a rate limit's wait, a sign-in failure.
import { isAuthError, retryAfterMs } from './inbox-core'

import type {
  Approval,
  ApprovalsFeed,
  ListedTicket,
  Milestone,
  OtherTouch,
  PaneView,
  PendingApproval,
  Ticket,
  TicketList,
  Touched,
} from './touched-types'
export type { Approval, ApprovalsFeed, ListedTicket, Milestone, OtherTouch, PaneView, PendingApproval, Ticket, TicketList, Touched }

export const MAX_MILESTONES = 15
export const MAX_TICKETS = 30
export const PENDING_CALLS_KEPT = 64
export const STORE_PREFIX = 'touched:'
export const PORTAL = 'https://portal.apphandoff.com'

const REF = /^(HO|MS)-\d+$/
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const empty = (): Touched => ({ milestones: [], tickets: [], server: null })

// --- transcript rows ---------------------------------------------------------

export type PendingCall = { tool: string; args: Record<string, unknown> }
export type ToolCallSeen = { tool: string; args: Record<string, unknown>; text?: string; isError: boolean }

function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts = content
    .map((c) => (isRecord(c) && typeof c.text === 'string' ? c.text : ''))
    .filter((t) => t !== '')
  return parts.length > 0 ? parts.join('\n') : undefined
}

export function recordToolUses(pending: Map<string, PendingCall>, content: unknown, server: string | null): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_use') continue
    if (typeof block.id !== 'string' || typeof block.name !== 'string') continue
    const name = parseToolName(block.name)
    // an id-named server's call is held until its answer says whose it is
    if (!name || !(mayBeAppHandoff(name.server, name.tool) || name.server === server)) continue
    pending.set(block.id, { tool: block.name, args: isRecord(block.input) ? block.input : {} })
    while (pending.size > PENDING_CALLS_KEPT) pending.delete(pending.keys().next().value as string)
  }
}

export function finishedCalls(pending: Map<string, PendingCall>, content: unknown): ToolCallSeen[] {
  if (!Array.isArray(content)) return []
  const seen: ToolCallSeen[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    const call = pending.get(block.tool_use_id)
    if (!call) continue
    pending.delete(block.tool_use_id)
    seen.push({ tool: call.tool, args: call.args, text: toolResultText(block.content), isError: block.is_error === true })
  }
  return seen
}

export function readRow(
  pending: Map<string, PendingCall>,
  server: string | null,
  row: { door: string; content: unknown },
): ToolCallSeen[] {
  if (row.door === 'response') {
    recordToolUses(pending, row.content, server)
    return []
  }
  if (row.door !== 'tool-result') return []
  return finishedCalls(pending, row.content)
}

// --- learning ----------------------------------------------------------------

export function parseJson(text: string | undefined): unknown {
  if (!text) return undefined
  const start = text.search(/[[{]/)
  if (start < 0) return undefined
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return undefined
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

/** Every `HO-n` / `MS-n` string in a value, to a bounded depth. */
export function refsIn(value: unknown, depth = 4, out = new Set<string>()): Set<string> {
  if (depth < 0) return out
  if (typeof value === 'string') {
    if (REF.test(value)) out.add(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 50)) refsIn(v, depth - 1, out)
    return out
  }
  if (isRecord(value)) {
    for (const v of Object.values(value).slice(0, 50)) refsIn(v, depth - 1, out)
  }
  return out
}

type Card = {
  ref: string
  title: string | null
  status: string | null
  stage: string | null
  milestone: string | null
  goal: string | null
  open: number | null
  total: number | null
}

/** Objects carrying a `ref` of ours, anywhere in a JSON answer (cards, lists, bundles). */
export function cardsIn(value: unknown, depth = 7, out: Card[] = []): Card[] {
  if (depth < 0 || out.length > 200) return out
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 100)) cardsIn(v, depth - 1, out)
    return out
  }
  if (!isRecord(value)) return out
  const ref = str(value.ref)
  if (ref && REF.test(ref)) {
    const ms = isRecord(value.milestone) ? str(value.milestone.ref) : str(value.milestone)
    out.push({
      ref,
      title: str(value.title) ?? str(value.name),
      status: str(value.status),
      stage: str(value.stage),
      milestone: ms && REF.test(ms) ? ms : null,
      goal: str(value.goal),
      open: isRecord(value.tickets) && typeof value.tickets.open === 'number' ? value.tickets.open : null,
      total: isRecord(value.tickets) && typeof value.tickets.total === 'number' ? value.tickets.total : null,
    })
  }
  for (const v of Object.values(value)) if (typeof v === 'object' && v !== null) cardsIn(v, depth - 1, out)
  return out
}

/**
 * A gated write the human has not decided: the flat, success-shaped answer
 * `{awaiting_approval: true, proposal_id, portal_url, …}` (the card fields, when
 * the caller got a card, sit at the same top level). Nothing was applied.
 */
export const isAwaitingApproval = (json: unknown): json is Record<string, unknown> =>
  isRecord(json) && json.awaiting_approval === true

/**
 * The human gate on a write, when the answer carries one: the awaiting result,
 * or a `PROPOSAL_PENDING` error (a different proposal already waits on the
 * target). The link is kept only when it is on the portal origin; otherwise
 * `url` is empty and the caller falls back to the milestone's own portal link.
 */
export function approvalIn(
  json: unknown,
  now: number,
  server: string,
): { approval: Approval; milestoneTitle: string | null; kind: string | null } | null {
  if (!isRecord(json)) return null
  const root = isRecord(json.refusal) ? json.refusal : json
  const awaiting = isAwaitingApproval(json)
  if (!awaiting && str(root.code) !== 'PROPOSAL_PENDING') return null
  const appr = isRecord(root.approval) ? root.approval : null
  const proposal_id = awaiting ? str(json.proposal_id) : str(appr?.ref)
  if (!proposal_id) return null
  const link = awaiting ? str(json.portal_url) : str(appr?.url)
  const url = link?.startsWith(`${PORTAL}/`) ? link : ''
  return {
    approval: { proposal_id, server, url, to_status: awaiting ? str(json.to_status) : null, seen_at: now },
    milestoneTitle: awaiting ? str(json.milestone_title) : null,
    kind: awaiting ? str(json.kind) : null,
  }
}

/** The proposal kinds that are a milestone's own approval: the only gates a milestone row waits on. */
const MILESTONE_GATE_KINDS: ReadonlySet<string> = new Set(['milestone_approve', 'milestone_accept', 'milestone_drop'])

/** `decide_lifecycle_proposal`'s reply: which proposal ended, and how. */
export function decisionIn(json: unknown): { proposal_id: string; status: 'applied' | 'rejected' } | null {
  if (!isRecord(json)) return null
  const id = str(json.proposal_id)
  const s = json.status
  if (!id || (s !== 'applied' && s !== 'rejected')) return null
  return { proposal_id: id, status: s }
}

/** The decision a `decide_lifecycle_proposal` answer text confirms, or null. */
export const decisionOf = (text: string | undefined) => decisionIn(parseJson(text))

/**
 * What a call did, as its touch remembers it: the tool and its op, plus the
 * stage a move went to (`ticket move up_next`) and `criteria` for an update
 * that rewrote the acceptance criteria, so the pane can say it in words.
 */
export function actionLabel(tool: string, args: Record<string, unknown>): string {
  const op = isRecord(args.op) ? args.op : null
  const action = op ? str(op.action) : null
  if (!op || !action) return tool
  const stage = action === 'move' ? str(op.stage) : null
  if (stage) return `${tool} ${action} ${stage}`
  if (action === 'update' && op.acceptance_criteria !== undefined) return `${tool} ${action} criteria`
  return `${tool} ${action}`
}

/** What a card or call teaches about a milestone; null and undefined both mean "not said". */
type MilestonePatch = {
  title?: string | null
  status?: string | null
  approval?: Approval | null
  goal?: string | null
  open?: number | null
  total?: number | null
  project?: string | null
}

/** How far along each milestone status is: an approval ends once the milestone reaches its target. */
const STATUS_RANK: Record<string, number> = { draft: 0, approved: 1, building: 2, built: 3, done: 4, dropped: 4 }

/** Whether a milestone at `status` has got past the approval that asked for `target`. */
export function approvalSettled(status: string | null, target: string | null): boolean {
  const at = status === null ? undefined : STATUS_RANK[status]
  const goal = STATUS_RANK[target ?? 'approved']
  return at !== undefined && goal !== undefined && at >= goal
}

/**
 * The milestone with what the patch says laid over it; the optional fields
 * only when known. An approval the milestone has already moved past (decided
 * in the portal, say) is dropped: nothing waits on the person any more.
 */
function patched(cur: Milestone | undefined, ref: string, patch: MilestonePatch, at: number, action: string): Milestone {
  const goal = patch.goal ?? cur?.goal
  const open = patch.open ?? cur?.open
  const total = patch.total ?? cur?.total
  const project = patch.project ?? cur?.project
  const status = patch.status ?? cur?.status ?? null
  const approval = patch.approval !== undefined ? patch.approval : (cur?.approval ?? null)
  return {
    ref,
    title: patch.title ?? cur?.title ?? null,
    status,
    approval: approval && approvalSettled(status, approval.to_status) ? null : approval,
    last_at: at,
    last_action: action,
    ...(goal != null ? { goal } : {}),
    ...(open != null ? { open } : {}),
    ...(total != null ? { total } : {}),
    ...(project != null ? { project } : {}),
  }
}

function upsertMilestone(list: Milestone[], ref: string, patch: MilestonePatch, now: number, action: string): Milestone[] {
  const next = patched(list.find((m) => m.ref === ref), ref, patch, now, action)
  return [next, ...list.filter((m) => m.ref !== ref)].slice(0, MAX_MILESTONES)
}

/** The project a call named (`project_id` / `project`), else the one its answer reports. */
export function projectOf(args: Record<string, unknown>, json: unknown): string | null {
  const named = str(args.project_id) ?? str(args.project)
  if (named) return named
  if (!isRecord(json)) return null
  if (isRecord(json.project)) return str(json.project.id) ?? str(json.project.name)
  return str(json.project_id)
}

function upsertTicket(list: Ticket[], ref: string, patch: Partial<Ticket>, now: number, action: string): Ticket[] {
  const cur = list.find((t) => t.ref === ref)
  const next: Ticket = {
    ref,
    title: patch.title ?? cur?.title ?? null,
    stage: patch.stage ?? cur?.stage ?? null,
    status: patch.status ?? cur?.status ?? null,
    milestone: patch.milestone ?? cur?.milestone ?? null,
    last_at: now,
    last_action: action,
  }
  return [next, ...list.filter((t) => t.ref !== ref)].slice(0, MAX_TICKETS)
}

/**
 * One finished AppHandoff call. Refs named in the ARGUMENTS are touched (the
 * chat asked about them) unless the call failed or was a listing (`find`,
 * `bootstrap`); cards in the ANSWER refresh title / status of rows already
 * touched, or add the one the call was about. The connection is pinned: the
 * first AppHandoff server learned stays the only one, so a later server never
 * takes over the rows or the decisions sent through them. A gated move's
 * awaiting answer is not a landed touch, but it attaches its approval.
 */
export function learn(state: Touched, call: ToolCallSeen, now: number): { state: Touched; changed: boolean } {
  const name = parseToolName(call.tool)
  if (!name) return { state, changed: false }
  const known = state.server === name.server
  if (!known && (state.server !== null || !isAppHandoffCall(name.server, name.tool, call.text, call.isError))) {
    return { state, changed: false }
  }
  let next: Touched = known ? state : { ...state, server: name.server }
  let changed = !known
  const action = actionLabel(name.tool, call.args)
  const json = parseJson(call.text)
  // An awaiting_approval answer is a success on the wire, but nothing was applied.
  const landed = !call.isError && !isAwaitingApproval(json)
  // Every milestone this call touches remembers the project it named: the pane's reads pass it.
  const project = projectOf(call.args, json)
  const upsertMs = (list: Milestone[], ref: string, patch: MilestonePatch, act: string) =>
    upsertMilestone(list, ref, project ? { ...patch, project } : patch, now, act)

  // 1. what the call named
  const argRefs = [...refsIn(call.args)]
  const isListing = name.tool === 'find' || name.tool === 'bootstrap'
  if (landed && !isListing) {
    for (const ref of argRefs) {
      if (ref.startsWith('MS-')) next = { ...next, milestones: upsertMs(next.milestones, ref, {}, action) }
      else next = { ...next, tickets: upsertTicket(next.tickets, ref, {}, now, action) }
      changed = true
    }
  }

  // 2. what the answer says about rows we hold (or the one the call was about)
  const cards = landed ? cardsIn(json) : []
  const single = cards.length === 1 && !isListing
  for (const c of cards) {
    if (c.ref.startsWith('MS-')) {
      const held = next.milestones.some((m) => m.ref === c.ref)
      if (!held && (isListing || (!single && !argRefs.includes(c.ref)))) continue
      next = { ...next, milestones: upsertMs(next.milestones, c.ref, { title: c.title, status: c.status, goal: c.goal, open: c.open, total: c.total }, action) }
      changed = true
    } else {
      const held = next.tickets.some((t) => t.ref === c.ref)
      if (!held && (isListing || (!single && !argRefs.includes(c.ref)))) continue
      next = {
        ...next,
        tickets: upsertTicket(next.tickets, c.ref, { title: c.title, stage: c.stage, status: c.status, milestone: c.milestone }, now, action),
      }
      changed = true
      // a ticket card names its milestone: touched through the ticket
      if (c.milestone) next = { ...next, milestones: upsertMs(next.milestones, c.milestone, {}, `${action} (via ${c.ref})`) }
    }
  }

  // 2b. a write's answer card carries no ref (`{card:{status, stage, …}}`):
  //     it is about the entity the call named in `ref`
  //     A create names no ref; its card says `ticket_ref: "HO-n-<project slug>"`.
  const wrote = landed && isRecord(json) && isRecord(json.card) && !str(json.card.ref) ? json.card : null
  const created = /^(HO-\d+)(?:-|$)/.exec(str(wrote?.ticket_ref) ?? '')?.[1] ?? null
  const target = str(call.args.ref) ?? created
  if (created && target === created && isRecord(call.args.op)) {
    const op = call.args.op
    const ms = str(op.milestone_id)
    next = {
      ...next,
      tickets: upsertTicket(next.tickets, created, { title: str(op.title), milestone: ms && REF.test(ms) ? ms : null }, now, action),
    }
    if (ms && REF.test(ms) && ms.startsWith('MS-')) next = { ...next, milestones: upsertMs(next.milestones, ms, {}, `${action} (via ${created})`) }
  }
  if (wrote && target && REF.test(target)) {
    if (target.startsWith('MS-')) {
      next = { ...next, milestones: upsertMs(next.milestones, target, { status: str(wrote.status) }, action) }
    } else {
      next = { ...next, tickets: upsertTicket(next.tickets, target, { status: str(wrote.status), stage: str(wrote.stage) }, now, action) }
    }
    changed = true
  }

  // 3. a human gate on a milestone move: only a `plan` call's milestone proposal (or the
  //    PROPOSAL_PENDING error, which names no kind). A ticket gate (`ticket_gate`) or a program
  //    commit may name an MS-n in its args, but it is not that milestone's approval.
  const gate = approvalIn(json, now, name.server)
  if (gate && name.tool === 'plan' && (gate.kind === null ? !isAwaitingApproval(json) : MILESTONE_GATE_KINDS.has(gate.kind))) {
    const msRef =
      argRefs.find((r) => r.startsWith('MS-')) ??
      next.milestones.find((m) => gate.milestoneTitle && m.title === gate.milestoneTitle)?.ref ??
      null
    if (msRef) {
      const approval = { ...gate.approval, url: gate.approval.url || portalUrl(msRef) }
      next = { ...next, milestones: upsertMs(next.milestones, msRef, { approval }, `${action} → awaiting approval`) }
      changed = true
    }
  }

  // 4. a decision taken (by the pane's button or the chat itself)
  const decided = landed ? decisionIn(json) : null
  if (decided && name.tool === 'decide_lifecycle_proposal') {
    const m = next.milestones.find((x) => x.approval?.proposal_id === decided.proposal_id)
    if (m) {
      const status = decided.status === 'applied' ? (m.approval?.to_status ?? m.status) : m.status
      next = { ...next, milestones: upsertMs(next.milestones, m.ref, { approval: null, status }, `decided ${decided.status}`) }
      changed = true
    }
  }

  return { state: next, changed }
}

/** Fold several finished calls into the state, in order: what `update` runs on the CURRENT state. */
export function learnAll(state: Touched, calls: readonly ToolCallSeen[], now: number): { state: Touched; changed: boolean } {
  let cur = state
  let changed = false
  for (const call of calls) {
    const learned = learn(cur, call, now)
    cur = learned.state
    changed = changed || learned.changed
  }
  return { state: cur, changed }
}

// --- display ----------------------------------------------------------------

export function ageText(now: number, at: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function statusLine(state: Touched): string | undefined {
  const awaiting = state.milestones.filter((m) => m.approval).length
  if (state.milestones.length === 0 && state.tickets.length === 0) return undefined
  const parts = [`${state.milestones.length} MS`, `${state.tickets.length} HO`]
  if (awaiting > 0) parts.push(`${awaiting} awaiting approval`)
  return `touched: ${parts.join(' · ')}`
}

export function portalUrl(ref: string): string {
  return `${PORTAL}/${ref}`
}

/**
 * Whether a pane may open unasked: only where the surface docks it as a
 * sidebar (`viewport.isFullscreen === true`), and only once. Absent or false
 * (unknown, or the main screen's inline pane) leaves only the status line.
 */
export const mayOpenUnasked = (isFullscreen: boolean | undefined, opened: boolean): boolean =>
  isFullscreen === true && !opened

/**
 * Whether a client that attached docks a pane beside the transcript: what it
 * reported with its size, else true for the desktop app, which places a
 * plugin's pane beside the chat; unknown for any other surface.
 */
export const attachDocks = (surface: string, isFullscreen: boolean | undefined): boolean | undefined =>
  isFullscreen ?? (surface === 'desktop' ? true : undefined)

export type Stored = { touched: Touched; saved_at: number }
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000

/** A stored chat older than the retention window (or junk): fromStored ignores it and session.start prunes it. */
export const storedExpired = (v: unknown, now: number): boolean =>
  !isRecord(v) || typeof v.saved_at !== 'number' || now - v.saved_at > RETENTION_MS

export function fromStored(v: unknown, now: number): Touched {
  if (!isRecord(v) || !isRecord(v.touched) || typeof v.saved_at !== 'number') return empty()
  if (now - v.saved_at > RETENTION_MS) return empty()
  const t = v.touched
  return {
    // An approval without the server it came through, or one the milestone has
    // since moved past, waits on nobody: drop it.
    milestones: Array.isArray(t.milestones)
      ? (t.milestones as Milestone[]).map((m) =>
          m.approval && (typeof m.approval.server !== 'string' || approvalSettled(m.status, m.approval.to_status))
            ? { ...m, approval: null }
            : m,
        )
      : [],
    tickets: Array.isArray(t.tickets) ? (t.tickets as Ticket[]) : [],
    server: typeof t.server === 'string' ? t.server : null,
  }
}

// --- the Milestones pane (HO-17571) -------------------------------------------
// One plain table per section; a row opens in place to list its milestone's
// tickets as sub-rows, read once through the chat's own connection when it opens.

export const emptyView = (): PaneView => ({ open: null, lists: {}, all: null, others: {}, names: {} })

/** A small label: its word and the background it is drawn on, a theme key so it follows the person's theme. */
export type Label = { text: string; color: string }

// Maps, not object literals: a status is the server's string, and `constructor` must not find a function.
const STATUS_COLORS = new Map([
  ['draft', 'subtle'],
  ['approved', 'suggestion'],
  ['building', 'suggestion'],
  ['built', 'suggestion'],
  ['done', 'success'],
  ['dropped', 'inactive'],
])

/** A milestone's status as a label; none for a status the pane does not know. */
export function statusLabel(status: string | null): Label | null {
  const color = status === null ? undefined : STATUS_COLORS.get(status)
  return status !== null && color !== undefined ? { text: status, color } : null
}

export const openCount = (tickets: readonly ListedTicket[]): number => tickets.filter((t) => t.status !== 'closed').length

/** Open tickets of a milestone: from the read list once it holds them all, else the card's count. */
const openOf = (m: Milestone, list: TicketList | undefined): number | undefined =>
  list?.status === 'ready' && list.total <= list.tickets.length ? openCount(list.tickets) : m.open

export type Progress = { closed: number; total: number }

/**
 * How far a milestone's tickets are along, only when the whole is known: the
 * read list once it holds them all, else a card that carried both counts.
 */
export function progressOf(m: Milestone, list: TicketList | undefined): Progress | null {
  if (list?.status === 'ready' && list.total <= list.tickets.length) {
    const total = list.tickets.length
    return total > 0 ? { closed: total - openCount(list.tickets), total } : null
  }
  if (m.total !== undefined && m.open !== undefined && m.total > 0 && m.open <= m.total) {
    return { closed: m.total - m.open, total: m.total }
  }
  return null
}

export const progressText = (p: Progress): string => `${p.closed}/${p.total}`

/** Below this many columns the table drops its Status and Updated columns. */
export const NARROW_COLUMNS = 60

export const isNarrow = (columns: number | undefined): boolean => columns !== undefined && columns < NARROW_COLUMNS

export type ColumnId = 'ref' | 'title' | 'status' | 'tail' | 'updated'
/** One table column: a fixed width in cells, or null for the one that takes the rest (the title). */
export type Column = { id: ColumnId; header: string; width: number | null }

export const REF_WIDTH = 10
export const STATUS_WIDTH = 9
export const TICKETS_WIDTH = 9
export const UPDATED_WIDTH = 7
export const APPROVE_TEXT = 'Approve in portal'

/**
 * The columns of one section's table, left to right: ref, title (takes the
 * rest), status, the tail (Tickets, or the Approve link while waiting) and
 * updated (`updated` cells wide: see updatedWidth). A narrow pane keeps only
 * ref, title and the tail.
 */
export function tableColumns(bodyColumns: number | undefined, waiting: boolean, updated = UPDATED_WIDTH): Column[] {
  const tail: Column = waiting
    ? { id: 'tail', header: 'Approval', width: APPROVE_TEXT.length }
    : { id: 'tail', header: 'Tickets', width: TICKETS_WIDTH }
  const head: Column[] = [
    { id: 'ref', header: 'Milestone', width: REF_WIDTH },
    { id: 'title', header: 'Title', width: null },
  ]
  if (isNarrow(bodyColumns)) return [...head, tail]
  return [...head, { id: 'status', header: 'Status', width: STATUS_WIDTH }, tail, { id: 'updated', header: 'Updated', width: updated }]
}

/** The Tickets cell: `3/8` when the total is known, else `5 open`, else blank. */
export function ticketsCell(m: Milestone, list: TicketList | undefined): string {
  const progress = progressOf(m, list)
  if (progress) return progressText(progress)
  const open = openOf(m, list)
  return open === undefined ? '' : `${open} open`
}

// Maps, not object literals: a stage is the server's string, and `constructor` must not find a function.
const STAGE_WORDS = new Map([
  ['backlog', 'backlog'],
  ['up_next', 'next'],
  ['in_progress', 'doing'],
  ['validation', 'checking'],
  ['live', 'live'],
])
const STAGE_RANK = new Map([
  ['in_progress', 0],
  ['validation', 1],
  ['up_next', 2],
  ['backlog', 3],
  ['live', 4],
])

/** A ticket's stage in one short plain word. */
export function stageWord(t: ListedTicket): string {
  if (t.status === 'closed') return 'closed'
  return (t.stage ? STAGE_WORDS.get(t.stage) : undefined) ?? t.stage ?? '?'
}

/** Work under way first, then what is next, then the rest; closed last; ties newest first. */
export function orderTickets(list: readonly ListedTicket[]): ListedTicket[] {
  const rank = (t: ListedTicket) => (t.status === 'closed' ? 9 : ((t.stage ? STAGE_RANK.get(t.stage) : undefined) ?? 5))
  const num = (t: ListedTicket) => Number(t.ref.slice(3))
  return [...list].sort((a, b) => rank(a) - rank(b) || num(b) - num(a))
}

export const LIST_LIMIT = 50

/** What the pane's reads add: the project the chat named, and the chat's own agent id. */
function scope(project: string | null, sessionId: string): Record<string, unknown> {
  return { ...(project ? { project } : {}), ...(sessionId ? { agent_id: `cc:${sessionId}` } : {}) }
}

/** The pane's read of an opened milestone's tickets: one `find`, read-only. */
export const findTicketsArgs = (ref: string, project: string | null, sessionId: string): Record<string, unknown> => ({
  type: 'ticket',
  filter: { milestone: ref },
  fields: ['ref', 'title', 'stage', 'status', 'updated_at'],
  limit: LIST_LIMIT,
  ...scope(project, sessionId),
})

/** The pane's read of an opened milestone's card, for its goal and a fresh status. */
export const getMilestoneArgs = (ref: string, project: string | null, sessionId: string): Record<string, unknown> => ({
  ref,
  ...scope(project, sessionId),
})

/** The pane's read of an opened milestone's project, once: its name and repos name a title's redundant prefix. */
export const getProjectArgs = (project: string | null, sessionId: string): Record<string, unknown> => ({
  ref: '$project',
  ...scope(project, sessionId),
})

/** An answer's JSON: its structured part when there is one, else its text. */
export const answerJson = (structured: unknown, text: string | undefined): unknown =>
  isRecord(structured) ? structured : parseJson(text)

/** A `find` answer's tickets, in pane order, or null when the answer is no list. */
export function ticketListIn(json: unknown): { tickets: ListedTicket[]; total: number } | null {
  if (!isRecord(json) || !Array.isArray(json.items)) return null
  const tickets = json.items.flatMap((it): ListedTicket[] => {
    if (!isRecord(it) || typeof it.ref !== 'string' || !/^HO-\d+$/.test(it.ref)) return []
    return [{ ref: it.ref, title: str(it.title), stage: str(it.stage), status: str(it.status), updated_at: str(it.updated_at) }]
  })
  return { tickets: orderTickets(tickets), total: typeof json.total === 'number' ? json.total : tickets.length }
}

/**
 * The card of the milestone the pane read itself refreshes the row it holds
 * (title, status, goal, open count) without moving it or counting as a touch.
 */
export function refreshMilestone(state: Touched, ref: string, json: unknown): Touched {
  const card = cardsIn(json).find((c) => c.ref === ref)
  if (!card || !state.milestones.some((m) => m.ref === ref)) return state
  const patch = { title: card.title, status: card.status, goal: card.goal, open: card.open, total: card.total }
  return {
    ...state,
    milestones: state.milestones.map((m) => (m.ref === card.ref ? patched(m, m.ref, patch, m.last_at, m.last_action) : m)),
  }
}

/**
 * Whether one of the chat's own calls changed what an opened milestone lists:
 * a landed write (`ticket`, `plan`) on the AppHandoff server that names the
 * milestone (filing into it included) or one of its listed tickets. A read
 * changes nothing, so it never re-reads.
 */
export function touchesMilestone(
  call: ToolCallSeen,
  server: string | null,
  ref: string,
  listed: readonly ListedTicket[],
): boolean {
  const name = parseToolName(call.tool)
  if (!name || name.server !== server || call.isError) return false
  if (name.tool !== 'ticket' && name.tool !== 'plan') return false
  // An awaiting_approval answer is a success on the wire, but nothing was applied: nothing to re-read.
  if (isAwaitingApproval(parseJson(call.text))) return false
  const named = refsIn(call.args)
  return named.has(ref) || listed.some((t) => named.has(t.ref))
}

/**
 * The opened milestone a batch of the chat's own calls makes the pane read
 * again, or null: only one the pane still holds (an evicted one has lost its
 * project), and only when a call changed it (touchesMilestone).
 */
export function rereadTarget(view: PaneView, state: Touched, calls: readonly ToolCallSeen[]): string | null {
  const ref = view.open
  if (!ref || !state.milestones.some((m) => m.ref === ref)) return null
  const shown = view.lists[ref]
  const listed = shown?.status === 'ready' ? shown.tickets : []
  return calls.some((c) => touchesMilestone(c, state.server, ref, listed)) ? ref : null
}

/**
 * One ticket-list read per milestone at a time. An open or Retry while one is
 * out sends nothing more; a write that lands meanwhile (`fresh`) is owed one
 * read after it, since the read out may have left before the write.
 */
export function listReads() {
  const out = new Set<string>()
  const owed = new Set<string>()
  return {
    /** Whether to start a read now. */
    begin(ref: string, fresh: boolean): boolean {
      if (!out.has(ref)) {
        out.add(ref)
        return true
      }
      if (fresh) owed.add(ref)
      return false
    },
    /** The read ended; whether one more is owed. */
    end(ref: string): boolean {
      out.delete(ref)
      return owed.delete(ref)
    },
  }
}

/** How many ticket lines an opened milestone gets: what the pane's height leaves, 3 to 12. */
export const ticketRoom = (viewRows: number | undefined, otherLines: number): number =>
  Math.max(3, Math.min(12, (viewRows ?? 30) - otherLines - 4))

// --- touched-first tickets (HO-17669) ------------------------------------------
// An opened milestone lists the tickets this chat touched (open first) and one
// line that folds out the whole list. A ticket a chat touched carries a marker
// and says what was done to it and when; its title drops the project prefix the
// milestone already implies, and takes two lines where the pane is wide.

/** How long another chat's touch of a ticket marks it. */
export const OTHERS_WINDOW_MS = 24 * 60 * 60 * 1000
export const MARK = '●'
/** The markers' colours, from the pane's status palette: this chat's, another chat's. */
export const MINE_COLOR = 'suggestion'
export const OTHER_COLOR = 'success'

const TICKET_REF = /^HO-\d+$/

/**
 * Other chats' touches of tickets in the last 24 h, the newest per HO ref,
 * from the `touched:<sessionId>` entries this plugin saves; this chat's own
 * entry (`ownKey`), expired and junk entries skipped. HO-n is one serial
 * across projects, so the ref alone names the ticket.
 */
export function othersTouched(
  entries: ReadonlyArray<readonly [string, unknown]>,
  ownKey: string,
  now: number,
): Record<string, OtherTouch> {
  const out: Record<string, OtherTouch> = {}
  for (const [key, value] of entries) {
    if (!key.startsWith(STORE_PREFIX) || key === ownKey) continue
    for (const t of fromStored(value, now).tickets as unknown[]) {
      if (!isRecord(t) || typeof t.ref !== 'string' || !TICKET_REF.test(t.ref)) continue
      if (typeof t.last_at !== 'number' || now - t.last_at > OTHERS_WINDOW_MS) continue
      const cur = out[t.ref]
      if (cur && cur.last_at >= t.last_at) continue
      out[t.ref] = { last_at: t.last_at, last_action: typeof t.last_action === 'string' ? t.last_action : '' }
    }
  }
  return out
}

/** A ticket's marker: this chat's touch first, else another chat's within 24 h, else none. */
export function markOf(ref: string, mine: ReadonlySet<string>, other: OtherTouch | undefined, now: number): Label | null {
  if (mine.has(ref)) return { text: MARK, color: MINE_COLOR }
  if (other && now - other.last_at <= OTHERS_WINDOW_MS) return { text: MARK, color: OTHER_COLOR }
  return null
}

/** The line under an opened milestone's tickets that folds the list: its words, and the `all` it sets. */
export type Fold = { text: string; all: boolean }

/**
 * Which of a read list's tickets an opened milestone shows. By default only
 * the ones this chat touched (the list's order: open first), with `show all N`;
 * folded out, the whole list with `show touched`. Either way what the pane has
 * no room for is `more`. No fold line when every ticket was touched.
 */
export function shownTickets(
  list: { tickets: readonly ListedTicket[]; total: number },
  mine: ReadonlySet<string>,
  all: boolean,
  room: number,
): { rows: ListedTicket[]; fold: Fold | null; more: number } {
  const touched = list.tickets.filter((t) => mine.has(t.ref))
  const everyTouched = touched.length >= list.total
  if (all || everyTouched) {
    const rows = list.tickets.slice(0, room)
    return { rows, fold: everyTouched ? null : { text: 'show touched', all: false }, more: Math.max(0, list.total - rows.length) }
  }
  const rows = touched.slice(0, room)
  return { rows, fold: { text: `show all ${list.total}`, all: true }, more: touched.length - rows.length }
}

// Maps, not object literals: an action is the server's string, and `constructor` must not find a function.
const ACTION_WORDS = new Map([
  ['create', 'created'],
  ['update', 'updated'],
  ['close', 'closed'],
  ['reopen', 'reopened'],
  ['claim', 'claimed'],
  ['release', 'released'],
  ['archive', 'archived'],
  ['link', 'linked'],
  ['send', 'messaged'],
  ['reply', 'replied'],
])
const READ_TOOLS = new Set(['get', 'find', 'bootstrap', 'read_skill'])

/** A touch's action label (actionLabel) in plain words: `created`, `criteria updated`, `moved to next`, `closed`, `read`. */
export function actionWords(label: string): string {
  const [tool = '', action, detail] = label.trim().split(/\s+/)
  if (!action) return READ_TOOLS.has(tool) ? 'read' : tool.replace(/_/g, ' ')
  if (action === 'move') return detail ? `moved to ${STAGE_WORDS.get(detail) ?? detail.replace(/_/g, ' ')}` : 'moved'
  if (action === 'update' && detail === 'criteria') return 'criteria updated'
  return ACTION_WORDS.get(action) ?? action.replace(/_/g, ' ')
}

/**
 * A ticket's Updated cell: `<last action> <age>` from this chat's touch, else
 * another chat's; an untouched ticket the board's age, else blank.
 */
export function actionCell(t: ListedTicket, mine: Ticket | undefined, other: OtherTouch | undefined, now: number): string {
  const touch = mine ?? other
  if (touch) return [actionWords(touch.last_action), ageText(now, touch.last_at)].filter((p) => p !== '').join(' ')
  const at = t.updated_at ? Date.parse(t.updated_at) : Number.NaN
  return Number.isFinite(at) ? ageText(now, at) : ''
}

/** The Updated column's widest, and the title's narrowest, when the column widens for an opened milestone. */
export const UPDATED_MAX = 24
export const MIN_TITLE = 20

/** Cells between a table's columns (the row's gap). */
const COLUMN_GAP = 1

/** The title column's cells in a pane `bodyColumns` wide; null when the width is unknown or the pane narrow. */
export function titleWidth(cols: readonly Column[], bodyColumns: number | undefined): number | null {
  if (bodyColumns === undefined || isNarrow(bodyColumns)) return null
  const fixed = cols.reduce((n, c) => n + (c.width ?? 0), 0)
  return Math.max(1, bodyColumns - fixed - COLUMN_GAP * (cols.length - 1))
}

/**
 * How wide a section's Updated column is: its longest cell, at least the
 * usual width, at most UPDATED_MAX, and never so wide the title keeps fewer
 * than MIN_TITLE cells. A narrow pane has no such column.
 */
export function updatedWidth(texts: readonly string[], bodyColumns: number | undefined, waiting: boolean): number {
  const longest = Math.max(UPDATED_WIDTH, ...texts.map((t) => t.length))
  const title = titleWidth(tableColumns(bodyColumns, waiting), bodyColumns)
  if (title === null || longest === UPDATED_WIDTH) return UPDATED_WIDTH
  const spare = UPDATED_WIDTH + Math.max(0, title - MIN_TITLE)
  return Math.max(UPDATED_WIDTH, Math.min(longest, UPDATED_MAX, spare))
}

/** A section's columns: its Updated column fits the opened milestone's ticket lines when it holds that milestone. */
export const sectionColumns = (bodyColumns: number | undefined, waiting: boolean, opened: readonly TicketRow[] | null): Column[] =>
  tableColumns(bodyColumns, waiting, opened ? updatedWidth(opened.map((r) => r.updated), bodyColumns, waiting) : UPDATED_WIDTH)

/**
 * A title laid out in at most `maxLines` lines of `width` cells: whole words
 * where they fit (a word too long for a line is split), the last line ending
 * in `…` when the title runs on. The lines joined by newlines, and how many.
 */
export function fitTitle(text: string, width: number, maxLines = 2): { text: string; lines: number } {
  const w = Math.max(2, Math.floor(width))
  const words = text.trim().split(/\s+/).filter((x) => x !== '')
  const lines: string[] = []
  let cur = ''
  let i = 0
  while (i < words.length && lines.length < maxLines) {
    const word = words[i] as string
    if (cur === '' && word.length > w) {
      lines.push(word.slice(0, w))
      words[i] = word.slice(w)
    } else if (cur === '') {
      cur = word
      i++
    } else if (cur.length + 1 + word.length <= w) {
      cur = `${cur} ${word}`
      i++
    } else {
      lines.push(cur)
      cur = ''
    }
  }
  if (cur !== '') lines.push(cur)
  if (i < words.length && lines.length > 0) {
    const last = lines[lines.length - 1] as string
    lines[lines.length - 1] = `${last.length < w ? last : last.slice(0, w - 1).trimEnd()}…`
  }
  return { text: lines.join('\n'), lines: Math.max(1, lines.length) }
}

/** Names a project goes by, lowercased: its own and each repo's, as `owner/repo` and bare `repo`. */
function namesOf(values: readonly unknown[]): string[] {
  const out = new Set<string>()
  for (const v of values) {
    const s = str(v)?.trim().toLowerCase()
    if (!s) continue
    out.add(s)
    const bare = s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : ''
    if (bare) out.add(bare)
  }
  return [...out]
}

/** The names a `get {ref:"$project"}` answer gives the project (name and repos), or null when it carries no project. */
export function projectNamesIn(json: unknown): string[] | null {
  const items = isRecord(json) && Array.isArray(json.items) ? json.items : [json]
  const p = items.find((it): it is Record<string, unknown> => isRecord(it) && it.kind === 'project')
  if (!p) return null
  return namesOf([p.name, ...(Array.isArray(p.repos) ? p.repos : [])])
}

/** The names a milestone's ticket titles may lead with: the read project's, and the one the chat named. */
export const prefixNames = (read: readonly string[] | undefined, held: string | undefined): string[] =>
  [...new Set([...(read ?? []), ...namesOf([held])])]

/**
 * A ticket title without the leading project or repo it repeats: `[x] t`,
 * `x: t` and `x (area): t` (kept as `area: t`) when x is one of `names`
 * (any case). Anything else, or what would leave nothing, unchanged.
 */
export function cleanTitle(title: string, names: readonly string[]): string {
  if (names.length === 0) return title
  const named = (x: string | undefined) => x !== undefined && names.includes(x.trim().toLowerCase())
  const bracket = /^\[([^\]]+)\]\s*(\S[\s\S]*)$/.exec(title)
  if (bracket && named(bracket[1])) return bracket[2] as string
  const area = /^([^:()[\]]+?)\s*\(([^()]+)\):\s+(\S[\s\S]*)$/.exec(title)
  if (area && named(area[1])) return `${(area[2] as string).trim()}: ${area[3]}`
  const plain = /^([^:()[\]]+?):\s+(\S[\s\S]*)$/.exec(title)
  if (plain && named(plain[1])) return plain[2] as string
  return title
}

/** One ticket line of an opened milestone, ready to draw. */
export type TicketRow = { ticket: ListedTicket; mark: Label | null; title: string; updated: string }

/**
 * What an opened milestone draws under its row: the tickets shownTickets
 * picks, each with its marker, its title without the project prefix and its
 * Updated cell; the fold line; and how many more the portal lists.
 */
export function openedTickets(
  list: { tickets: readonly ListedTicket[]; total: number },
  ctx: {
    mine: readonly Ticket[]
    others: Record<string, OtherTouch>
    names: readonly string[]
    all: boolean
    room: number
    now: number
  },
): { rows: TicketRow[]; fold: Fold | null; more: number } {
  const mine = new Map(ctx.mine.map((t) => [t.ref, t]))
  const mineRefs = new Set(mine.keys())
  const shown = shownTickets(list, mineRefs, ctx.all, ctx.room)
  const rows = shown.rows.map((t) => {
    const own = mine.get(t.ref)
    const other = ctx.others[t.ref]
    // a touch older than the window (the pane stayed open past it) no longer counts
    const recent = other && ctx.now - other.last_at <= OTHERS_WINDOW_MS ? other : undefined
    return {
      ticket: t,
      mark: markOf(t.ref, mineRefs, recent, ctx.now),
      title: t.title === null ? '—' : cleanTitle(t.title, ctx.names),
      updated: actionCell(t, own, recent, ctx.now),
    }
  })
  return { rows, fold: shown.fold, more: shown.more }
}

// --- approvals from other chats (HO-17578) -------------------------------------
// While the Milestones pane is open it reads every milestone approval waiting
// on the person (`find {type:"proposal"}`, HO-17557): on its first draw, then
// every 60 s, one read at a time. Those rows join Waiting on you beside the
// chat's own learned approvals, one row per proposal. Every row is a link to
// the portal; the pane never decides an approval.

export const APPROVALS_POLL_MS = 60_000
/** Failed reads in a row that stop the polling until Retry. */
export const APPROVALS_STOP_AFTER = 3
export const PROPOSAL_LIMIT = 50
export const SIGN_IN_NEEDED = 'Approvals from other chats need a signed-in connection'

export const emptyFeed = (): ApprovalsFeed => ({
  status: 'idle',
  items: [],
  complete: false,
  read_at: null,
  failures: 0,
  retry_at: null,
  error: null,
})

/** The pane's read of every pending approval: no project (every one the person can read), the chat's agent id. */
export const findProposalsArgs = (sessionId: string): Record<string, unknown> => ({
  type: 'proposal',
  limit: PROPOSAL_LIMIT,
  ...scope(null, sessionId),
})

/** A `find {type:"proposal"}` answer's approvals and whether it holds them all, or null when the answer is no list. */
export function proposalsIn(json: unknown): { items: PendingApproval[]; complete: boolean } | null {
  if (!isRecord(json) || !Array.isArray(json.items)) return null
  const seen = new Set<string>()
  const items = json.items.flatMap((it): PendingApproval[] => {
    if (!isRecord(it)) return []
    const proposal_id = str(it.proposal_id)
    if (!proposal_id || seen.has(proposal_id)) return []
    const target = isRecord(it.target) ? it.target : {}
    const named = str(target.ref)
    const ref = named && /^MS-\d+$/.test(named) ? named : null
    const link = str(it.portal_url)
    // only a portal page: never a link the answer could point anywhere else
    const url = link?.startsWith(`${PORTAL}/`) ? link : ref ? portalUrl(ref) : null
    if (!url) return []
    seen.add(proposal_id)
    const project = isRecord(it.project) ? { id: str(it.project.id), name: str(it.project.name) } : null
    return [
      {
        proposal_id,
        ref,
        title: str(target.title),
        project,
        from_status: str(it.from_status),
        to_status: str(it.to_status),
        proposed_by: str(it.proposed_by),
        created_at: str(it.created_at),
        url,
      },
    ]
  })
  const complete = !str(json.next_cursor) && typeof json.total === 'number' && json.total <= json.items.length
  return { items, complete }
}

export type ProposalAnswer = { ok: true; json: unknown } | { ok: false; text: string }

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 160) || 'unknown error'

/**
 * A server that has no proposal read refuses our fixed arguments: its `find`
 * rejects the type (INVALID_ARGUMENT, or the SDK's input validation). The pane
 * then stays learn-only and shows no error.
 */
export const proposalReadUnsupported = (text: string): boolean =>
  /INVALID_ARGUMENT|-32602|input validation error|invalid arguments for tool/i.test(text)

function readFailed(feed: ApprovalsFeed, why: string): ApprovalsFeed {
  const failures = feed.failures + 1
  const stopped = failures >= APPROVALS_STOP_AFTER
  return {
    ...feed,
    status: stopped ? 'stopped' : feed.status,
    items: stopped ? [] : feed.items,
    failures,
    retry_at: null,
    error: oneLine(why),
  }
}

/**
 * Fold one read's answer into the feed. A list replaces the rows. A token
 * connection (UNSUPPORTED_AUTH) and a server without the read end the polling
 * for good; a sign-in failure, or 3 failed reads in a row, stop it until
 * Retry; a rate limit waits as long as the server says and counts as no failure.
 */
export function approvalsRead(feed: ApprovalsFeed, answer: ProposalAnswer, sentAt: number, now: number): ApprovalsFeed {
  if (answer.ok) {
    const page = proposalsIn(answer.json)
    if (!page) return readFailed(feed, 'no proposal list in the answer')
    return { status: 'ready', items: page.items, complete: page.complete, read_at: sentAt, failures: 0, retry_at: null, error: null }
  }
  const text = answer.text
  if (/UNSUPPORTED_AUTH/.test(text)) return { ...emptyFeed(), status: 'needs-sign-in' }
  if (proposalReadUnsupported(text)) return { ...emptyFeed(), status: 'learn-only' }
  const wait = retryAfterMs(text)
  if (wait !== null) return { ...feed, retry_at: now + wait, error: oneLine(text) }
  if (isAuthError(text)) return { ...feed, status: 'stopped', items: [], failures: feed.failures + 1, retry_at: null, error: 'sign-in failed' }
  return readFailed(feed, text)
}

/** Whether the feed still reads at all: not once the server or the connection said no, nor while stopped. */
export const approvalsPolling = (feed: ApprovalsFeed): boolean => feed.status === 'idle' || feed.status === 'ready'

/** When to read next: a rate limit's wait, else 60 s; null when the feed reads no more. */
export function approvalsNextMs(feed: ApprovalsFeed, now: number): number | null {
  if (!approvalsPolling(feed)) return null
  if (feed.retry_at !== null && feed.retry_at > now) return feed.retry_at - now
  return APPROVALS_POLL_MS
}

/** Retry: a stopped feed reads again from a clean count. */
export const approvalsRetry = (feed: ApprovalsFeed): ApprovalsFeed =>
  feed.status === 'stopped' ? { ...feed, status: 'idle', failures: 0, retry_at: null, error: null } : feed

/** The one line the feed adds to the pane, or null: the token connection's dim line, or the stop with Retry. */
export function approvalsLine(feed: ApprovalsFeed): { text: string; retry: boolean } | null {
  if (feed.status === 'needs-sign-in') return { text: SIGN_IN_NEEDED, retry: false }
  if (feed.status !== 'stopped') return null
  const why = feed.error === 'sign-in failed' ? 'sign-in failed' : `${APPROVALS_STOP_AFTER} reads failed in a row`
  return { text: `Approvals from other chats stopped: ${why}`, retry: true }
}

/**
 * Whether a feed row is about a held milestone: the same MS-n in the same
 * project, when both projects are known. A project the chat named as
 * `owner/repo` is neither the row's id nor its name, so there the MS-n alone
 * tells (one global sequence, 20261009180100_global_milestone_program_numbers)
 * and a draft's own row carries its approval (HO-17669).
 */
function sameMilestone(m: Milestone, row: PendingApproval): boolean {
  if (m.ref !== row.ref) return false
  const held = m.project
  if (!held || !row.project) return true
  return held === row.project.id || held === row.project.name || held.includes('/')
}

const SETTLED_BY_READ = new Set(['approved', 'done'])

/**
 * What the pane shows: the chat's milestones, a held milestone the feed says
 * waits on the person carrying that approval (shown only), and the feed's
 * other approvals as rows of their own. One row per proposal: a proposal the
 * chat learned itself is not shown twice, nor one for a milestone the chat
 * holds that already moved past it or waits on another proposal.
 */
export function withFeed(state: Touched, feed: ApprovalsFeed): { milestones: Milestone[]; remote: PendingApproval[] } {
  if (feed.status !== 'ready' || feed.items.length === 0) return { milestones: state.milestones, remote: [] }
  const held = new Set(state.milestones.flatMap((m) => (m.approval ? [m.approval.proposal_id] : [])))
  const attach = new Map<string, PendingApproval>()
  const remote: PendingApproval[] = []
  for (const item of feed.items) {
    if (held.has(item.proposal_id)) continue
    const m = item.ref ? state.milestones.find((x) => sameMilestone(x, item)) : undefined
    if (!m) {
      remote.push(item)
      continue
    }
    if (!m.approval && !attach.has(m.ref) && !approvalSettled(m.status, item.to_status)) attach.set(m.ref, item)
  }
  const milestones = state.milestones.map((m) => {
    const item = attach.get(m.ref)
    if (!item) return m
    const approval: Approval = {
      proposal_id: item.proposal_id,
      server: state.server ?? '',
      url: item.url,
      to_status: item.to_status,
      seen_at: m.last_at,
    }
    return { ...m, approval }
  })
  return { milestones, remote }
}

/**
 * A complete read that no longer lists an approval this chat learned ends it:
 * decided in the portal, from whichever chat. Only a milestone approve or
 * accept (what the read lists), and only one learned before the read left.
 */
export function settleApprovals(state: Touched, feed: ApprovalsFeed): { state: Touched; changed: boolean } {
  const readAt = feed.read_at
  if (feed.status !== 'ready' || !feed.complete || readAt === null) return { state, changed: false }
  const listed = new Set(feed.items.map((i) => i.proposal_id))
  let changed = false
  const milestones = state.milestones.map((m) => {
    const a = m.approval
    if (!a || listed.has(a.proposal_id) || a.seen_at >= readAt || !SETTLED_BY_READ.has(a.to_status ?? '')) return m
    changed = true
    return { ...m, approval: null }
  })
  return changed ? { state: { ...state, milestones }, changed } : { state, changed }
}

export type PaneGroup = { key: 'waiting' | 'recent'; title: string; milestones: Milestone[]; remote: PendingApproval[] }

/**
 * The pane's two sections: Waiting on you (the milestones carrying an approval,
 * then the feed's own rows) and Recent (every other milestone, newest touch
 * first, whatever its status); empty ones left out.
 */
export function paneGroups(list: readonly Milestone[], remote: readonly PendingApproval[]): PaneGroup[] {
  const recent = list.filter((m) => !m.approval).sort((a, b) => b.last_at - a.last_at)
  const groups: PaneGroup[] = [
    { key: 'waiting', title: 'Waiting on you', milestones: list.filter((m) => m.approval), remote: [...remote] },
    { key: 'recent', title: 'Recent', milestones: recent, remote: [] },
  ]
  return groups.filter((g) => g.milestones.length + g.remote.length > 0)
}

/** A feed row's Updated cell: how long ago it was asked for, blank when the answer carried no time. */
export function remoteAge(a: PendingApproval, now: number): string {
  const at = a.created_at ? Date.parse(a.created_at) : Number.NaN
  return Number.isFinite(at) ? ageText(now, at) : ''
}

/** A feed row's dim detail line: its project, the move it asks for, who asked, and how long ago. */
export function remoteMeta(a: PendingApproval, now: number): string {
  const at = a.created_at ? Date.parse(a.created_at) : Number.NaN
  return [
    a.project?.name ?? null,
    `${a.from_status ?? '?'} → ${a.to_status ?? '?'}`,
    a.proposed_by ? `asked by ${a.proposed_by}` : null,
    Number.isFinite(at) ? ageText(now, at) : null,
  ]
    .filter((p): p is string => p !== null)
    .join(' · ')
}
