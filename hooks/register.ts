// AppHandoff for Claude Code — the plugin's hooks module: the inbox add-on
// (HO-16353) and, composed in by `register`, the touched panes (HO-17539).
//
// Wakes this chat when someone else posts on a ticket it claimed or created,
// when a person decides a milestone approval it asked for (HO-17707: read
// from the board's notice list, the catch-up every IDE reads), and when a
// person accepts or drops a milestone this chat or its builders worked on
// (HO-19052: followed from its own plan calls, no proposal of its own). Every decision
// lives in ./inbox-core.ts (pure, unit-tested); this file only moves what the
// engine says into it and acts on what it returns. Nothing here may throw
// into the chat: every hook and timer path catches.

import type { EngineInterface, McpToolResult, Register } from 'claude-code'
import * as core from './inbox-core'
import { statusWith } from './status-line'
import { registerPanes } from './touched'

let state: core.InboxState | null = null
let timer: { cancel: () => void } | null = null
let polling = false
let off = false
/** Arguments of the chat's own AppHandoff calls still awaiting their result, by tool_use id. */
const pendingCalls = new Map<string, core.PendingCall>()

const textOf = (r: McpToolResult) =>
  r.content.map((c) => ('text' in c && typeof c.text === 'string' ? c.text : '')).join('\n')

type Answer = { ok: true; json: unknown } | { ok: false; text: string }

/** The first content block's text: where a `get` answer carries its JSON when there is no structuredContent. */
const firstTextOf = (r: McpToolResult) => {
  const c = r.content[0]
  return c && 'text' in c && typeof c.text === 'string' ? c.text : undefined
}

/** One thread read: `get {ref, expand: ["messages"]}`, answered as the ticket payload the core reads. */
async function readThread($: EngineInterface, server: string, args: Record<string, unknown>): Promise<Answer> {
  if (state) state = { ...state, calls: state.calls + 1 }
  try {
    const r = await $.mcp.call(server, 'get', args)
    if (r.isError) return { ok: false, text: textOf(r) || 'get failed' }
    const card = core.ticketFromCard(core.v3Json(r.structuredContent, firstTextOf(r)))
    return card ? { ok: true, json: card } : { ok: false, text: 'get returned no ticket card' }
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * One notice-list read (HO-17707): `message` notify_config include_missed. A
 * GUIDANCE_STALE refusal hands back the current revision: one retry with it.
 * A refusal answered as a plain result is a failure too.
 */
async function callNotices($: EngineInterface, server: string, req: core.NoticeRequest): Promise<Answer> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!state) return { ok: false, text: 'inbox stopped' }
    state = { ...state, calls: state.calls + 1 }
    let text: string
    try {
      const r = await $.mcp.call(server, 'message', core.noticeArgs(req, state))
      const json = core.v3Json(r.structuredContent, firstTextOf(r)) ?? core.parseJson(textOf(r))
      if (!r.isError && !(core.isRecord(json) && typeof json.code === 'string' && !core.noticesIn(json))) return { ok: true, json }
      text = textOf(r) || JSON.stringify(json ?? 'message failed')
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) }
    }
    const rev = core.staleGuidanceRev(text)
    if (!rev || attempt > 0) return { ok: false, text }
    if (state) state = { ...state, guidanceRev: rev }
  }
  return { ok: false, text: 'the rule-table revision kept changing' }
}

/**
 * One project's notices, newest first, walked back with next_before while a
 * page overflowed; the cursor moves to the newest notice once the walk ends.
 * A walk the page cap cuts off resumes from where it stopped on the next tick.
 */
async function readNotices(
  $: EngineInterface,
  server: string,
  req: core.NoticeRequest,
  now: number,
): Promise<{ ok: true; decided: core.ApprovalWait[]; settled: core.DrivenMilestone[] } | { ok: false; text: string }> {
  const decided: core.ApprovalWait[] = []
  const settled: core.DrivenMilestone[] = []
  const walk = state?.noticeWalks[req.projectId ?? '']
  let newest: string | null = walk?.newest ?? null
  let before: string | undefined = walk?.before
  let finished = false
  for (let page = 0; page < core.NOTICE_PAGES; page++) {
    const r = await callNotices($, server, before ? { ...req, before } : req)
    if (!r.ok) return r
    const list = core.noticesIn(r.json)
    if (!list) return { ok: false, text: 'notify_config returned no notice list' }
    if (!state) return { ok: false, text: 'inbox stopped' }
    newest ??= core.newestNotice(list)
    const applied = core.applyNotices(state, list, now, req.projectId)
    state = applied.state
    decided.push(...applied.decided)
    settled.push(...applied.settled)
    const waiting =
      state.approvals.some((a) => a.decided === null && a.projectId === req.projectId) ||
      state.driven.some((d) => d.settled === null && d.projectId === req.projectId)
    if (!list.truncated || !list.nextBefore || !waiting) {
      finished = true
      break
    }
    before = list.nextBefore
  }
  if (state) state = core.endNoticeWalk(state, req.projectId, newest, finished ? null : (before ?? null))
  return { ok: true, decided, settled }
}

async function save($: EngineInterface) {
  if (!state) return
  try {
    await $.store.set(core.STORE_PREFIX + state.sessionId, core.toStored(state, await $.clock.now()))
  } catch {}
}

/** One finished AppHandoff call: learn, show, re-plan. Never throws into the chat. */
async function learn($: EngineInterface, seen: core.ToolCallSeen, scope: core.RowScope) {
  if (!state) return
  // Read the time first: `state` must be read after every await, or a
  // tick that ran meanwhile is overwritten.
  const now = await $.clock.now()
  if (!state) return
  const learned = core.learnFromToolCall(state, seen, now, scope)
  state = learned.state
  if (learned.evicted.length > 0) {
    $.ui.toast(`AppHandoff inbox: watching ${core.MAX_WATCHED} tickets at most — dropped ${learned.evicted.join(', ')}`)
  }
  if (learned.changed) {
    show($)
    await save($)
    schedule($, 1_000)
  }
}

function show($: EngineInterface) {
  if (state) $.ui.status(statusWith('inbox', core.statusLine(state)))
}

function schedule($: EngineInterface, ms: number) {
  timer?.cancel()
  timer = null
  if (!state || off || !core.shouldPoll(state)) return
  timer = $.clock.after(ms, () => void tick($))
}

async function failed($: EngineInterface, text: string, now: number) {
  if (!state) return
  const r = core.pollFailed(state, text, now)
  state = r.state
  if (r.alert) $.ui.toast(core.AUTH_TOAST)
  else if (r.firstError) $.ui.toast(`AppHandoff inbox: poll failed — ${state.lastError}`)
}

/** One poll: baseline new watches, read every watched thread, maybe wake. */
async function tick($: EngineInterface) {
  if (polling || !state || off) return
  polling = true
  let now = 0
  try {
    now = await $.clock.now()
    const server = core.activeServer(state)
    if (!server) return
    state = core.expireApprovals(state, now)

    let failures = 0
    // A failed baseline read counts like a failed poll: it ends this tick's baselining,
    // never the polls or the notice read (a watched ticket must not silence an approval wake).
    for (const w of state.watched.filter((x) => !x.baselined)) {
      const r = await readThread($, server, core.baselineArgs(w, state))
      if (!r.ok && core.isNotFound(r.text)) {
        state = core.unwatch(state, w.ref).state
        $.ui.toast(`AppHandoff inbox: ${w.ref} not found — not watching it`)
        continue
      }
      if (!r.ok || core.ticketPayloads(r.json).length === 0) {
        failures++
        await failed($, r.ok ? `${w.ref}: no ticket returned` : r.text, now)
        if (!state || state.authStopped || state.retryAt !== null) return
        break
      }
      state = core.applyBaseline(state, w.ref, r.json)
    }

    const fresh: core.Fresh[] = []
    // One `get` per watched ticket.
    for (const req of core.pollPlan(state)) {
      const r = await readThread($, server, core.pollArgs(req, state))
      // Every ref in the read is gone: drop them, keep polling the rest.
      if (!r.ok && core.isNotFound(r.text)) {
        for (const id of req.ticketIds) state = core.unwatch(state, id).state
        $.ui.toast(`AppHandoff inbox: ${req.ticketIds.length} watched ticket(s) no longer found — not watching them`)
        continue
      }
      if (!r.ok) {
        failures++
        await failed($, r.text, now)
        if (!state || state.authStopped || state.retryAt !== null) return
        continue
      }
      for (const payload of core.ticketPayloads(r.json)) {
        const applied = core.applyWindow(state, payload, now)
        state = applied.state
        fresh.push(...applied.fresh)
      }
    }
    // Milestone approvals this chat asked for: one notice read per project while one waits.
    const decided: core.ApprovalWait[] = []
    const settled: core.DrivenMilestone[] = []
    for (const req of core.noticePlan(state)) {
      const r = await readNotices($, server, req, now)
      if (!state) return
      if (r.ok) {
        decided.push(...r.decided)
        settled.push(...r.settled)
        continue
      }
      if (core.isScopeRefusal(r.text) || core.isLastingRefusal(r.text)) {
        if (!state.approvalsOff) $.ui.toast(core.isScopeRefusal(r.text) ? core.APPROVALS_OFF_TOAST : core.approvalsRefusedToast(r.text))
        state = core.approvalsOff(state)
        break
      }
      failures++
      await failed($, r.text, now)
      if (!state || state.authStopped || state.retryAt !== null) return
    }
    if (failures === 0) state = core.pollOk(state, now)

    for (const a of decided) $.ui.toast(core.approvalToastText(a))
    for (const d of settled) $.ui.toast(core.drivenToastText(d))
    for (const f of fresh.slice(0, 3)) $.ui.toast(core.toastText(f))
    if (fresh.length > 3) $.ui.toast(`AppHandoff inbox: ${fresh.length - 3} more new message(s)`)

    // The chat's own post can reach the thread before its tool result reaches
    // us; give that result a moment so decideWake can drop the chat's own id.
    if (fresh.length > 0) await $.clock.sleep(core.OWN_WRITE_SETTLE_MS)

    const decidedAt = await $.clock.now()
    const d = core.decideWake(state, decidedAt)
    state = d.state
    if (d.tripped) $.ui.toast(core.LIMIT_TOAST)
    if (d.wake || d.approvals.length > 0 || d.driven.length > 0) {
      $.prompt
        .submit({ text: core.wakePrompt(d.wake, d.approvals, state.sessionId, d.driven) })
        .then(
          (r) => !('drop' in r && r.drop !== undefined),
          () => false,
        )
        .then(async (entered) => {
          if (!state) return
          state = entered ? core.settleWake(state, decidedAt) : core.abortWake(state)
          if (!entered) $.ui.toast('AppHandoff inbox: the wake did not reach the chat — will retry')
          show($)
          await save($)
        })
        .catch(() => undefined)
    }
  } catch (err) {
    if (state) state = { ...state, lastError: err instanceof Error ? err.message : String(err) }
  } finally {
    polling = false
    try {
      show($)
      await save($)
      if (state) schedule($, core.pollIntervalMs(state, now || (await $.clock.now())))
    } catch {}
  }
}

/**
 * The plugin's one hooks module (hooks.json names one per plugin): the touched
 * panes (./touched.tsx) register their hooks, then the inbox below. Neither
 * reads the other's state; they share only the status line (./status-line.ts)
 * and which server is AppHandoff (./apphandoff-server.ts).
 */
export const register: Register = (on) => {
  registerPanes(on)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      await $.command.register({
        name: 'inbox',
        description: 'AppHandoff inbox: what this chat watches; pause or resume wakes',
        argumentHint: '[pause|resume]',
      })
    } catch {}
    try {
      off = core.isOff(await $.env.get('APPHANDOFF_INBOX'))
      const sessionId = await $.session.id()
      const now = await $.clock.now()
      const own = await $.store.get(core.STORE_PREFIX + sessionId)
      state = core.fromStored(sessionId, core.expired(own, now) ? undefined : own, now)
      if (off) return result
      for (const key of await $.store.keys()) {
        if (key.startsWith(core.STORE_PREFIX) && key !== core.STORE_PREFIX + sessionId) {
          if (core.expired(await $.store.get(key), now)) await $.store.delete(key)
        }
      }
      show($)
      schedule($, 1_000)
    } catch {}
    return result
  })

  // The chat's own AppHandoff calls teach the add-on everything: which
  // connection to use, what it claimed or created, which messages are its own.
  //
  // Read from the transcript, never from `tool.call` (HO-16419): this module
  // runs in a worker, and a `tool.call` hook carries every call — Bash in an
  // isolated subagent included — through that worker, where the engine lost
  // the agent's worktree context and refused every builder's shell command.
  // A response row records each call's arguments by id; the tool-result row
  // that follows carries the answer. A subagent's rows (`agentId`) teach only
  // what it wrote, never a watch (core.learnFromToolCall).
  on('session.append', { door: ['response', 'tool-result'] }, async ($, e, next) => {
    const result = await next(e)
    if (off || !state) return result
    const { scope, calls } = core.readRow(pendingCalls, state.servers, {
      door: e.door,
      content: e.message.content,
      agentId: e.agentId,
    })
    for (const seen of calls) {
      try {
        await learn($, seen, scope)
      } catch {}
    }
    return result
  })

  on('command.run', { command: 'inbox' }, async ($, e) => {
    try {
      if (off) return { text: 'inbox: off (APPHANDOFF_INBOX=off). Unset it and start a new chat to turn it on.' }
      if (!state) return { text: 'inbox: not started yet' }
      const now = await $.clock.now()
      const command = core.parseCommand(e.args)
      if (command === 'pause') state = { ...state, paused: 'user' }
      if (command === 'resume') {
        state = core.resume(state)
        schedule($, 1_000)
      }
      if (command === 'unknown') return { text: 'inbox: usage /inbox [pause|resume]' }
      show($)
      await save($)
      return { text: core.describe(state, now) }
    } catch (err) {
      return { text: `inbox: ${err instanceof Error ? err.message : String(err)}` }
    }
  })
}
