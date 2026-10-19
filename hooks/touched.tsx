// AppHandoff for Claude Code — the touched Milestones pane (HO-17539).
//
// One pane tab, Milestones, lists what this chat's own AppHandoff calls
// touched as a plain table, one line per milestone. Learned from the
// transcript (`session.append`), never from a `tool.call` hook: that worker
// path broke subagent shells (HO-16419). Every decision lives in
// ./touched-core.ts (pure, unit-tested); this file only wires the engine and
// draws. Nothing here may throw into the chat.
//
// What the pane reads of its own, all read-only through the chat's own
// AppHandoff connection with its agent id:
// - Every approval waiting on the person, from any chat (HO-17578): one
//   `find {type:"proposal"}` when the Milestones pane first draws, then every
//   60 s while it is open (closing it stops the reads), one read at a time. A
//   rate limit waits as long as the server says; 3 failed reads in a row or a
//   sign-in failure stop it, said on the pane with Retry. A token connection
//   is told once ("need a signed-in connection") and a server without the read
//   leaves the pane learn-only; neither reads again. Those rows join Waiting on
//   you, one per proposal; a complete read that no longer lists one this chat
//   learned ends it.
// - An opened milestone's tickets and card (HO-17571, `find` + `get`): when the
//   row opens, on Retry, and when this chat's own write changes that milestone.
//   With them (HO-17669): the milestone's project, once (`get {ref:"$project"}`),
//   whose name and repos a ticket title's prefix may repeat; and, from this
//   plugin's own local store (no board read), the tickets other chats touched in
//   the last 24 h. The list shows the tickets this chat touched until `show all`.
// Every approval is an "Approve in portal" link; the pane never decides one.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'
import { statusWith } from './status-line'
import * as core from './touched-core'

const MS_PANE = 'ah-milestones'
const touched = atom({ plugin: 'apphandoff', key: 'touched' } as const, core.empty())
/** What the Milestones pane shows open; this session only, never stored. */
const paneView = atom({ plugin: 'apphandoff', key: 'view' } as const, core.emptyView())
/** Every approval waiting on the person, as the pane last read it; this session only, never stored. */
const approvals = atom({ plugin: 'apphandoff', key: 'approvals' } as const, core.emptyFeed())

/** Whether the Milestones pane is open: set by its first draw, cleared when it closes. */
let msPaneOpen = false
/** The approvals read under way (one at a time) and the timer for the next one. */
let approvalsOut = false
let approvalsTimer: { cancel: () => void } | null = null

/** Arguments of the chat's own AppHandoff calls still awaiting their result, by tool_use id. */
const pendingCalls = new Map<string, core.PendingCall>()
/** Ticket-list reads under way: one per milestone, plus one owed to a write that lands meanwhile. */
const reads = core.listReads()
/** Empty until the chat's id is known (a hook can run before session.start's read of it lands). */
let sessionId = ''
let opened = false
/** Whether the surface docks a pane beside the transcript; unknown until a drawing or a command says. */
let docked: boolean | undefined

const problem = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Save the list and show its status line, once the chat's id is known. */
async function settle($: EngineInterface, state: core.Touched) {
  if (sessionId === '') {
    try {
      sessionId = await $.session.id()
    } catch {}
  }
  if (sessionId === '') return
  try {
    await $.store.set(core.STORE_PREFIX + sessionId, { touched: state, saved_at: await $.clock.now() })
  } catch {}
  $.ui.status(statusWith('touched', core.statusLine(state)))
}

async function openPanes($: EngineInterface) {
  try {
    await $.ui.open({ id: MS_PANE, title: 'Milestones' })
    opened = true
  } catch {}
}

const textOf = (r: { content: ReadonlyArray<object> }) =>
  r.content.map((c) => ('text' in c && typeof c.text === 'string' ? c.text : '')).join('\n')

const setList = ($: EngineInterface, ref: string, list: core.TicketList) =>
  update($, paneView, (v) => ({ ...v, lists: { ...v.lists, [ref]: list } }))

/**
 * Read an opened milestone's tickets and card through the chat's own
 * AppHandoff connection: read-only, once per open, Retry or own write (`fresh`).
 * A list already shown stays up while it is read again. Never throws.
 */
async function readList($: EngineInterface, ref: string, fresh = false): Promise<void> {
  if (!reads.begin(ref, fresh)) return
  try {
    const state = await read($, touched)
    const server = state.server
    if (!server) {
      await setList($, ref, { status: 'error', message: 'no AppHandoff connection seen in this chat yet' })
      return
    }
    const project = state.milestones.find((m) => m.ref === ref)?.project ?? null
    const view = await read($, paneView)
    if (view.lists[ref]?.status !== 'ready') await setList($, ref, { status: 'loading' })
    const [listed, card, named] = await Promise.allSettled([
      $.mcp.call(server, 'find', core.findTicketsArgs(ref, project, sessionId)),
      $.mcp.call(server, 'get', core.getMilestoneArgs(ref, project, sessionId)),
      // the project's names, read once per milestone (a call that failed is tried again with the list)
      view.names?.[ref] ? Promise.resolve(null) : $.mcp.call(server, 'get', core.getProjectArgs(project, sessionId)),
    ])
    await readOthers($)
    if (named.status === 'fulfilled' && named.value) {
      // a refusal (no project for this chat, say) answers the same next time: kept as no names
      const r = named.value
      const names = r.isError ? [] : (core.projectNamesIn(core.answerJson(r.structuredContent, textOf(r))) ?? [])
      await update($, paneView, (v) => ({ ...v, names: { ...(v.names ?? {}), [ref]: names } }))
    }
    if (card.status === 'fulfilled' && !card.value.isError) {
      const json = core.answerJson(card.value.structuredContent, textOf(card.value))
      const written = await update($, touched, (s) => core.refreshMilestone(s, ref, json))
      await settle($, written)
    }
    if (listed.status === 'rejected') {
      await setList($, ref, { status: 'error', message: problem(listed.reason) })
      return
    }
    const r = listed.value
    const list = r.isError ? null : core.ticketListIn(core.answerJson(r.structuredContent, textOf(r)))
    await setList($, ref, list ? { status: 'ready', ...list } : { status: 'error', message: textOf(r).slice(0, 160) || 'no ticket list in the answer' })
  } catch (err) {
    await setList($, ref, { status: 'error', message: problem(err) }).catch(() => {})
  } finally {
    if (reads.end(ref)) void readAgainIfOpen($, ref)
  }
}

/** Other chats' tickets touched in the last 24 h, from the lists this plugin saved for them. Never throws. */
async function readOthers($: EngineInterface): Promise<void> {
  try {
    const own = core.STORE_PREFIX + sessionId
    const entries: [string, unknown][] = []
    for (const key of await $.store.keys()) {
      if (key.startsWith(core.STORE_PREFIX) && key !== own) entries.push([key, await $.store.get(key)])
    }
    const others = core.othersTouched(entries, own, await $.clock.now())
    await update($, paneView, (v) => ({ ...v, others }))
  } catch {}
}

/** The read a write owed, sent only if the milestone is still the open one. Never throws. */
async function readAgainIfOpen($: EngineInterface, ref: string): Promise<void> {
  try {
    if ((await read($, paneView)).open === ref) await readList($, ref, true)
  } catch {}
}

/** A row's press: open it (closing any other; it lists the touched tickets first) and read its tickets, or close it. Never throws. */
async function toggle($: EngineInterface, ref: string): Promise<void> {
  try {
    const v = await update($, paneView, (cur) => ({ ...cur, open: cur.open === ref ? null : ref, all: null }))
    if (v.open === ref) await readList($, ref)
  } catch {}
}

/** The fold line's press: the opened milestone lists all its tickets, or the touched ones again. Never throws. */
async function fold($: EngineInterface, ref: string, all: boolean): Promise<void> {
  try {
    await update($, paneView, (cur) => ({ ...cur, all: all ? ref : null }))
  } catch {}
}

function stopApprovals() {
  approvalsTimer?.cancel()
  approvalsTimer = null
}

/** The next approvals read, while the pane is open and the feed still reads. Never throws. */
async function scheduleApprovals($: EngineInterface): Promise<void> {
  try {
    stopApprovals()
    const ms = core.approvalsNextMs(await read($, approvals), await $.clock.now())
    if (ms === null || !msPaneOpen || approvalsOut) return
    approvalsTimer = $.clock.after(ms, () => void approvalsTick($))
  } catch {}
}

/** A timed read, only while the Milestones pane is still open (closed by any route, it reads no more). Never throws. */
async function approvalsTick($: EngineInterface): Promise<void> {
  approvalsTimer = null
  try {
    if (!(await $.ui.panes()).some((p) => p.id === MS_PANE)) {
      msPaneOpen = false
      return
    }
  } catch {}
  await readApprovals($)
}

/**
 * One read of every approval waiting on the person (`find {type:"proposal"}`),
 * through the chat's own AppHandoff connection; none while one is out, none
 * before a connection is learned. Never throws.
 */
async function readApprovals($: EngineInterface): Promise<void> {
  if (approvalsOut) return
  approvalsOut = true
  stopApprovals()
  try {
    if (!core.approvalsPolling(await read($, approvals))) return
    const server = (await read($, touched)).server
    if (!server) return
    const sentAt = await $.clock.now()
    let answer: core.ProposalAnswer
    try {
      const r = await $.mcp.call(server, 'find', core.findProposalsArgs(sessionId))
      answer = r.isError
        ? { ok: false, text: textOf(r) || 'find failed' }
        : { ok: true, json: core.answerJson(r.structuredContent, textOf(r)) }
    } catch (err) {
      answer = { ok: false, text: problem(err) }
    }
    const now = await $.clock.now()
    const feed = await update($, approvals, (f) => core.approvalsRead(f, answer, sentAt, now))
    let changed = false
    const written = await update($, touched, (s) => {
      const settled = core.settleApprovals(s, feed)
      changed = settled.changed
      return settled.state
    })
    if (changed) await settle($, written)
  } catch {
  } finally {
    approvalsOut = false
    await scheduleApprovals($)
  }
}

/** The Milestones pane drew: on its first draw since it opened, read the approvals at once. */
function paneDrawn($: EngineInterface) {
  if (msPaneOpen) return
  msPaneOpen = true
  void readApprovals($)
}

/** Retry on a stopped feed: count from zero and read now. Never throws. */
async function retryApprovals($: EngineInterface): Promise<void> {
  try {
    await update($, approvals, core.approvalsRetry)
    await readApprovals($)
  } catch {}
}

/** Open the pane unasked where the surface docks it, once, when the chat holds anything. */
async function openIfDocked($: EngineInterface, state: core.Touched) {
  if (core.statusLine(state) !== undefined && core.mayOpenUnasked(docked, opened)) await openPanes($)
}

/** Chat start: load this chat's saved list, prune stale saves. Never throws. */
async function onSessionStart($: EngineInterface): Promise<void> {
  try {
    sessionId = await $.session.id()
    const now = await $.clock.now()
    const state = core.fromStored(await $.store.get(core.STORE_PREFIX + sessionId), now)
    await update($, touched, () => state)
    $.ui.status(statusWith('touched', core.statusLine(state)))
    await openIfDocked($, state)
    for (const key of await $.store.keys()) {
      if (key.startsWith(core.STORE_PREFIX) && key !== core.STORE_PREFIX + sessionId) {
        if (core.storedExpired(await $.store.get(key), now)) await $.store.delete(key)
      }
    }
  } catch {}
}

/**
 * The chat's own AppHandoff calls teach everything: response rows carry the
 * arguments, the tool-result row that follows carries the answer. Never throws.
 */
async function onAppend($: EngineInterface, e: { door: string; message: { content: unknown } }): Promise<void> {
  try {
    const known = (await read($, touched)).server
    const calls = core.readRow(pendingCalls, known, { door: e.door, content: e.message.content })
    if (calls.length === 0) return
    const now = await $.clock.now()
    let changed = false
    // Folded into the state as it is when the write lands, not as it was read.
    const written = await update($, touched, (s) => {
      const learned = core.learnAll(s, calls, now)
      changed = learned.changed
      return learned.state
    })
    const again = core.rereadTarget(await read($, paneView), written, calls)
    if (again) void readList($, again, true)
    // The open pane waited for a connection to read approvals through: read now.
    if (known === null && written.server !== null && msPaneOpen) void readApprovals($)
    if (!changed) return
    await settle($, written)
    if (core.mayOpenUnasked(docked, opened)) await openPanes($)
  } catch {}
}

/**
 * The touched add-on's hooks, registered by register.ts (`$` never crosses an
 * import, so every hook that uses it is written in this file). Its
 * `session.start` and `session.append` carry matchers the inbox's do not: the
 * engine refuses a second matcher-less hook of the same event in one module.
 * The start matcher keeps every session: the desktop app runs on the SDK,
 * which starts non-interactive, and must still load its saved list.
 */
export const registerPanes: Register = (on) => {
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const result = await next(e)
    await onSessionStart($)
    return result
  })

  on('session.append', { door: ['tool-result', 'response'] }, async ($, e, next) => {
    const result = await next(e)
    await onAppend($, e)
    return result
  })

  // A client attaching (the desktop app, a phone) says whether its layout docks
  // a pane: a chat that already holds a list opens its pane there at once.
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    try {
      const docks = core.attachDocks(e.surface, e.viewport?.isFullscreen)
      if (docks !== undefined) docked = docks
      await openIfDocked($, await read($, touched))
    } catch {}
    return result
  })

  // The surface says whether it docks a pane on every drawing of a prompt row;
  // note it and pass the drawing on untouched.
  on('ui.render', { component: 'UserMessage' }, async (_$, e, next) => {
    if (e.viewport?.isFullscreen !== undefined) docked = e.viewport.isFullscreen
    return next(e)
  })

  // Closing the Milestones pane stops its approvals reads; its next draw starts them again.
  on('ui.close', { id: MS_PANE }, async (_$, e, next) => {
    const result = await next(e)
    msPaneOpen = false
    stopApprovals()
    return result
  })

  on('ui.render', { component: 'Pane', requestId: MS_PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    paneDrawn($)
    const state = await read($, touched)
    const view = await read($, paneView)
    const feed = await read($, approvals)
    const now = await $.clock.now()
    const { milestones, remote } = core.withFeed(state, feed)
    const said = core.approvalsLine(feed)
    const feedLine = said && (
      <Box key="approvals-line" flexDirection="row" gap={1}>
        <Box flexShrink={1} minWidth={0}>
          <Text dimColor={!said.retry} color={said.retry ? 'error' : undefined} wrap="truncate-end">
            {said.text}
          </Text>
        </Box>
        {said.retry && (
          <Button key="approvals-retry" dimColor onPress={() => retryApprovals($)}>
            Retry
          </Button>
        )}
      </Box>
    )
    if (milestones.length === 0 && remote.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No milestone touched yet. They show up here as this chat reads or changes them.</Text>
          {feedLine}
        </Box>
      )
    }
    const groups = core.paneGroups(milestones, remote)
    // each row is one line (a feed row has a detail line under it): count them against the pane's height
    const room = core.ticketRoom(e.viewport?.rows, milestones.length + remote.length * 2 + groups.length * 2 + 2)

    /** One table cell: a fixed-width box, or the title's box that takes the rest. */
    const cell = (c: core.Column, node: RenderChildren, indent = 0) =>
      c.width === null ? (
        <Box key={c.id} flexGrow={1} flexShrink={1} minWidth={0} paddingLeft={indent}>
          {node}
        </Box>
      ) : (
        <Box key={c.id} width={c.width} flexShrink={0} paddingLeft={indent}>
          {node}
        </Box>
      )

    const line = (key: string, cols: core.Column[], cells: Partial<Record<core.ColumnId, RenderChildren>>, indent = 0) => (
      <Box key={key} flexDirection="row" gap={1}>
        {cols.map((c) => cell(c, cells[c.id] ?? null, c.id === 'ref' ? indent : 0))}
      </Box>
    )

    const header = (cols: core.Column[]) => (
      <Box key="head" flexDirection="row" gap={1}>
        {cols.map((c) => cell(c, <Text dimColor bold wrap="truncate-end">{c.header}</Text>))}
      </Box>
    )

    /** The approval's portal page as a plain link; it sends nothing. */
    const approveLink = (id: string, url: string) => (
      <Link key={`approve-${id}`} href={url}>
        {core.APPROVE_TEXT}
      </Link>
    )

    /** The status as one coloured word; none for a status the pane does not know. */
    const statusText = (status: string | null) => {
      const label = core.statusLabel(status)
      return label && <Text color={label.color}>{label.text}</Text>
    }

    /** What an opened milestone's read list draws: the touched tickets first, marked and worded (HO-17669). */
    const openedOf = (m: core.Milestone, list: { tickets: core.ListedTicket[]; total: number }) =>
      core.openedTickets(list, {
        mine: state.tickets,
        others: view.others ?? {},
        names: core.prefixNames(view.names?.[m.ref], m.project),
        all: view.all === m.ref,
        room,
        now,
      })

    /** The sub-rows of an opened milestone, under its row in the same table. */
    const tickets = (m: core.Milestone, cols: core.Column[]) => {
      const list = view.lists[m.ref]
      if (!list || list.status === 'loading') {
        return (
          <Box key="sub-state" paddingLeft={2}>
            <Text dimColor>Loading tickets…</Text>
          </Box>
        )
      }
      if (list.status === 'error') {
        return (
          <Box key="sub-state" flexDirection="row" gap={1} paddingLeft={2}>
            <Text color="error">Couldn't load tickets</Text>
            <Button key={`retry-${m.ref}`} dimColor onPress={() => readList($, m.ref)}>
              Retry
            </Button>
            <Box flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-end">
                {list.message}
              </Text>
            </Box>
          </Box>
        )
      }
      if (list.tickets.length === 0) {
        return (
          <Box key="sub-state" paddingLeft={2}>
            <Text dimColor>No tickets yet</Text>
          </Box>
        )
      }
      const opened = openedOf(m, list)
      const folds = opened.fold
      const width = core.titleWidth(cols, e.props.bodyColumns)
      // the stage word sits under Status, or under the tail in a narrow pane
      const stageAt: core.ColumnId = cols.some((c) => c.id === 'status') ? 'status' : 'tail'
      /** The title: up to two lines where the pane is wide, else one cut short. */
      const titleOf = (r: core.TicketRow) => {
        const closed = r.ticket.status === 'closed'
        const fit = width === null ? null : core.fitTitle(r.title, width)
        if (!fit || fit.lines < 2) {
          return (
            <Text wrap="truncate-end" dimColor={closed}>
              {r.title}
            </Text>
          )
        }
        return (
          <Box height={fit.lines} overflow="hidden">
            <Text wrap="wrap" dimColor={closed}>
              {fit.text}
            </Text>
          </Box>
        )
      }
      return (
        <Box key="sub-rows" flexDirection="column">
          {opened.rows.map((r) =>
            line(
              `t-${r.ticket.ref}`,
              cols,
              {
                // a touched ticket's marker sits in the indent, so the refs still line up
                ref: r.mark ? (
                  <Box flexDirection="row" gap={1}>
                    <Text color={r.mark.color}>{r.mark.text}</Text>
                    <Link href={core.portalUrl(r.ticket.ref)}>{r.ticket.ref}</Link>
                  </Box>
                ) : (
                  <Link href={core.portalUrl(r.ticket.ref)}>{r.ticket.ref}</Link>
                ),
                title: titleOf(r),
                [stageAt]: <Text dimColor>{core.stageWord(r.ticket)}</Text>,
                updated: (
                  <Text dimColor wrap="truncate-end">
                    {r.updated}
                  </Text>
                ),
              },
              r.mark ? 0 : 2,
            ),
          )}
          {opened.more > 0 && (
            <Box paddingLeft={2}>
              <Link href={core.portalUrl(m.ref)}>{`${opened.more} more in the portal`}</Link>
            </Box>
          )}
          {folds && (
            <Box paddingLeft={2}>
              <Button key={`fold-${m.ref}`} plain dimColor hover={{ underline: true }} onPress={() => fold($, m.ref, folds.all)}>
                {folds.text}
              </Button>
            </Box>
          )}
        </Box>
      )
    }

    // One line: the MS ref (a portal link), the title (a Button that opens the row), the status word,
    // the tail (tickets done, or the Approve link while waiting) and how long ago.
    const row = (m: core.Milestone, cols: core.Column[]) => {
      const isOpen = view.open === m.ref
      return (
        <Box key={`ms-${m.ref}`} flexDirection="column">
          {line(`line-${m.ref}`, cols, {
            ref: <Link href={core.portalUrl(m.ref)}>{m.ref}</Link>,
            title: (
              <Button key={`open-${m.ref}`} plain dimColor={!isOpen && m.title === null} hover={{ underline: true }} wrap="truncate-end" onPress={() => toggle($, m.ref)}>
                {`${isOpen ? '▾' : '▸'} ${m.title ?? '—'}`}
              </Button>
            ),
            status: statusText(m.status),
            tail: m.approval ? approveLink(m.ref, m.approval.url) : <Text dimColor>{core.ticketsCell(m, view.lists[m.ref])}</Text>,
            updated: <Text dimColor>{core.ageText(now, m.last_at)}</Text>,
          })}
          {isOpen && (
            <Box key="opened" flexDirection="column">
              {tickets(m, cols)}
            </Box>
          )}
        </Box>
      )
    }

    // An approval from another chat: its title, status and the portal link, then who asked for which
    // move and when on a dim line under it; nothing to open.
    const remoteRow = (a: core.PendingApproval, cols: core.Column[]) => (
      <Box key={`pr-${a.proposal_id}`} flexDirection="column">
        {line(`line-${a.proposal_id}`, cols, {
          ref: a.ref ? <Link href={core.portalUrl(a.ref)}>{a.ref}</Link> : null,
          title: <Text wrap="truncate-end">{a.title ?? '—'}</Text>,
          status: statusText(a.from_status),
          tail: approveLink(a.proposal_id, a.url),
          updated: <Text dimColor>{core.remoteAge(a, now)}</Text>,
        })}
        <Box paddingLeft={2}>
          <Text dimColor wrap="truncate-end">
            {core.remoteMeta(a, now)}
          </Text>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {feedLine}
        {groups.map((g) => {
          const openHere = g.milestones.find((m) => m.ref === view.open)
          const list = openHere ? view.lists[openHere.ref] : undefined
          const opened = openHere && list?.status === 'ready' ? openedOf(openHere, list).rows : null
          const cols = core.sectionColumns(e.props.bodyColumns, g.key === 'waiting', opened)
          return (
            <Box key={`section-${g.key}`} flexDirection="column">
              {g.key === 'waiting' && <Text dimColor bold>{`${g.title} · ${g.milestones.length + g.remote.length}`}</Text>}
              {header(cols)}
              {g.milestones.map((m) => row(m, cols))}
              {g.remote.map((a) => remoteRow(a, cols))}
            </Box>
          )
        })}
      </Box>
    )
  })
}
