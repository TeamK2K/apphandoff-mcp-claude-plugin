// AppHandoff for Claude Code — the plugin's hooks module: the inbox add-on
// (HO-16353) and, composed in by `register`, the touched panes (HO-17539).
//
// Wakes this chat when someone else posts on a ticket it claimed or created,
// when a person decides a milestone approval it asked for (HO-17707: read
// from the board's notice list, the catch-up every IDE reads), and when a
// person accepts or drops a milestone this chat or its builders worked on
// (HO-19052: followed from its own plan calls, no proposal of its own). Watched
// tickets are polled with one `message` notify_config watch call per project, then
// one `get` per ticket it names as changed (HO-19546); a connection that cannot make
// that call reads every ticket with `get`, as before. Before it wakes the chat for a new message it
// claims the ticket for the chat (HO-19659: the plugin's one board write, under the chat's own
// agent id; another agent's lease means no wake), and it wakes the chat when a person answers
// a board question the chat asked. `/inbox standby <project ids>` (HO-19660) makes a chat a standing
// inbox: it claims, one a poll, a message nobody answered six minutes after it was posted
// and wakes the chat for it (a board question for a person's message, a reply-only wake for an outside
// agent's). Every decision
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
 * One `message` notify_config read: the notice list (HO-17707, include_missed) or
 * the watch list (HO-19546), or (`tool` ticket) the claim before a wake (HO-19659), or (`tool` question)
 * the standing inbox's open-question check (HO-19660).
 * `answers` says whether a JSON body is the answer asked for. A GUIDANCE_STALE
 * refusal hands back the current revision: one retry with it. A refusal answered
 * as a plain result is a failure too.
 */
async function callNotify(
  $: EngineInterface,
  server: string,
  argsOf: (s: core.InboxState) => Record<string, unknown>,
  answers: (json: unknown) => boolean,
  tool: 'message' | 'ticket' | 'question' = 'message',
): Promise<Answer> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!state) return { ok: false, text: 'inbox stopped' }
    state = { ...state, calls: state.calls + 1 }
    let text: string
    try {
      const r = await $.mcp.call(server, tool, argsOf(state))
      const json = core.v3Json(r.structuredContent, firstTextOf(r)) ?? core.parseJson(textOf(r))
      if (!r.isError && !(core.isRecord(json) && typeof json.code === 'string' && !answers(json))) return { ok: true, json }
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
): Promise<
  | { ok: true; decided: core.ApprovalWait[]; settled: core.DrivenMilestone[]; answered: core.QuestionWait[]; standbyStopped: boolean }
  | { ok: false; text: string }
> {
  const decided: core.ApprovalWait[] = []
  const settled: core.DrivenMilestone[] = []
  const answered: core.QuestionWait[] = []
  let standbyStopped = false
  const walk = state?.noticeWalks[req.projectId ?? '']
  let newest: string | null = walk?.newest ?? null
  let before: string | undefined = walk?.before
  let finished = false
  for (let page = 0; page < core.NOTICE_PAGES; page++) {
    const asked = before ? { ...req, before } : req
    const r = await callNotify($, server, (s) => core.noticeArgs(asked, s), (j) => core.noticesIn(j) !== null)
    if (!r.ok) return r
    const list = core.noticesIn(r.json)
    if (!list) return { ok: false, text: 'notify_config returned no notice list' }
    if (!state) return { ok: false, text: 'inbox stopped' }
    newest ??= core.newestNotice(list)
    const applied = core.applyNotices(state, list, now, req.projectId)
    state = applied.state
    decided.push(...applied.decided)
    settled.push(...applied.settled)
    answered.push(...applied.answered)
    standbyStopped ||= applied.standbyStopped
    const waiting =
      (state.standby?.projects.includes(req.projectId ?? '') ?? false) ||
      state.approvals.some((a) => a.decided === null && a.projectId === req.projectId) ||
      state.driven.some((d) => d.settled === null && d.projectId === req.projectId) ||
      state.questions.some((q) => q.answered === null && q.projectId === req.projectId)
    if (!list.truncated || !list.nextBefore || !waiting) {
      finished = true
      break
    }
    before = list.nextBefore
  }
  if (state) state = core.endNoticeWalk(state, req.projectId, newest, finished ? null : (before ?? null))
  return { ok: true, decided, settled, answered, standbyStopped }
}

/**
 * The claim before a wake (HO-19659): `ticket {op: claim}` under the chat's own agent id, so the
 * lease holder is the chat's and its own later claim renews it. What the answer means for the
 * wake is core.claimOutcome's; a passing failure counts like a failed poll, toasted once per ticket.
 */
async function claimBeforeWake($: EngineInterface, server: string, w: core.Watched, now: number): Promise<core.ClaimOutcome> {
  // No answer body is "the answer asked for" here: any coded body is a refusal for claimOutcome to read.
  const r = await callNotify($, server, (s) => core.claimArgs(w, s), () => false, 'ticket')
  const outcome = core.claimOutcome(state?.sessionId ?? '', r, now)
  if (outcome.kind === 'retry' && state) {
    const f = core.claimFailed(state, w, outcome.text, now)
    state = f.state
    if (f.toast) $.ui.toast(f.toast)
  }
  return outcome
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

type Polled = { fresh: core.Fresh[]; failures: number; stop: boolean }

/**
 * The reads this tick owes. The watch list names the changed tickets, so a quiet
 * board costs one call. A refusal for good (read-only scope, an older server) or an
 * answer without the list ends the list for this connection: every ticket is read.
 */
async function planReads($: EngineInterface, server: string, now: number, out: Polled): Promise<core.TicketRead[]> {
  if (!state) return []
  const plain = (scope: 'all' | 'unprojected') => (state ? core.pollPlan(state, scope).map(core.plainRead) : [])
  if (state.watchReadOff) return plain('all')
  const reads = plain('unprojected')
  for (const req of core.watchPlan(state)) {
    const r = await callNotify($, server, (s) => core.watchArgs(req, s), (j) => core.watchIn(j) !== null)
    if (!state) return []
    if (!r.ok && !core.watchRefused(r.text)) {
      out.failures++
      await failed($, r.text, now)
      if (!state || state.authStopped || state.retryAt !== null) {
        out.stop = true
        return []
      }
      continue
    }
    const answer = r.ok ? core.watchIn(r.json) : null
    if (!answer) {
      state = core.stopWatchReads(state)
      return plain('all')
    }
    state = core.advanceQuiet(core.applyWatchAnswer(state, req.projectId, answer), req, answer)
    for (const ref of answer.unknown) {
      const dropped = core.unwatch(state, ref)
      if (dropped.removed) {
        state = dropped.state
        $.ui.toast(`AppHandoff inbox: ${ref} not found — not watching it`)
      }
    }
    reads.push(...core.changedReads(state, answer.changed))
  }
  return reads
}

/** One `get` per read: a ticket that is gone is dropped, a failed read counts, the rest go on. */
async function readTickets($: EngineInterface, server: string, reads: core.TicketRead[], now: number, out: Polled) {
  for (const read of reads) {
    if (!state) return
    const r = await readThread($, server, core.pollArgs(read.req, state))
    if (!state) return
    // Every ref in the read is gone: drop them, keep polling the rest.
    if (!r.ok && core.isNotFound(r.text)) {
      for (const id of read.req.ticketIds) state = core.unwatch(state, id).state
      $.ui.toast(`AppHandoff inbox: ${read.req.ticketIds.length} watched ticket(s) no longer found — not watching them`)
      continue
    }
    if (!r.ok) {
      out.failures++
      await failed($, r.text, now)
      if (!state || state.authStopped || state.retryAt !== null) {
        out.stop = true
        return
      }
      continue
    }
    const payloads = core.ticketPayloads(r.json)
    for (const payload of payloads) {
      const applied = core.applyWindow(state, payload, now)
      state = applied.state
      out.fresh.push(...applied.fresh)
    }
    // Marked only once a thread was applied: a get with no usable thread leaves the change to be named again.
    if (payloads.length > 0) state = core.markRead(state, read)
  }
}

/** Submit a wake prompt; once it enters (or never does) settle (or abort) what it named. Fire and forget. */
function submitWake($: EngineInterface, text: string, decidedAt: number) {
  $.prompt
    .submit({ text })
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

/**
 * The standing inbox's one claim a poll (HO-19660): the oldest waiting message that has waited out the owning
 * chat's head start. An open board question on its ticket settles it without a claim; a lease someone else holds
 * settles it too (they are on it); a claim that lands wakes the chat (core.standbyWakeText). One message that keeps
 * failing is given up on after a few polls, so it never blocks the rest.
 */
async function standbyStep($: EngineInterface, server: string) {
  if (!state?.standby) return
  const noted = core.noteStandbyCap(state, await $.clock.now())
  state = noted.state
  if (noted.toast) $.ui.toast(noted.toast)
  let checks = 0
  for (const c of core.standbyDue(state, await $.clock.now())) {
    if (!state?.standby || checks++ >= core.STANDBY_CHECKS_PER_POLL) return
    const asked = await callNotify($, server, (s) => core.standbyQuestionArgs(c, s), () => false, 'question')
    if (!state?.standby) return
    // A refusal for good (this message's ticket cannot be read) settles the message and the loop goes on.
    if (!asked.ok && (core.isLastingRefusal(asked.text) || core.isScopeRefusal(asked.text))) {
      state = core.standbyHandled(state, [c])
      continue
    }
    const open = asked.ok ? core.openQuestionsIn(asked.json) : null
    if (open === null) {
      // A failure in passing: counted against the message (given up on after a few), the poll ends.
      const text = asked.ok ? 'question list returned no list' : asked.text
      const at = await $.clock.now()
      await failed($, text, at)
      if (state?.standby) state = core.applyStandbyClaim(state, c, { kind: 'retry', text }, at).state
      return
    }
    if (open) {
      state = core.standbyHandled(state, [c])
      continue
    }
    const claimAt = await $.clock.now()
    const r = await callNotify($, server, (s) => core.standbyClaimArgs(c, s), () => false, 'ticket')
    if (!state?.standby) return
    const outcome = core.claimOutcome(state.sessionId, r, claimAt)
    if (outcome.kind === 'retry') await failed($, outcome.text, claimAt)
    if (!state?.standby) return
    const applied = core.applyStandbyClaim(state, c, outcome, claimAt)
    state = applied.state
    if (applied.toast) $.ui.toast(applied.toast)
    if (applied.wake) submitWake($, core.standbyWakeText(applied.wake, state.sessionId, applied.claimed), claimAt)
    return
  }
}

/** One poll: baseline new watches, read what changed on the watched threads, maybe wake. */
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

    // One watch call per project names the changed tickets; each is read with one `get`
    // (all of them, one `get` apiece, when the board answers no watch list).
    const polled: Polled = { fresh: [], failures: 0, stop: false }
    await readTickets($, server, await planReads($, server, now, polled), now, polled)
    if (polled.stop || !state) return
    const fresh = polled.fresh
    failures += polled.failures
    // Milestone approvals this chat asked for: one notice read per project while one waits.
    const decided: core.ApprovalWait[] = []
    const settled: core.DrivenMilestone[] = []
    const answered: core.QuestionWait[] = []
    for (const req of core.noticePlan(state)) {
      const r = await readNotices($, server, req, now)
      if (!state) return
      if (r.ok) {
        decided.push(...r.decided)
        settled.push(...r.settled)
        answered.push(...r.answered)
        if (r.standbyStopped) $.ui.toast(core.STANDBY_OLD_SERVER_TOAST)
        continue
      }
      if (core.isScopeRefusal(r.text) || core.isLastingRefusal(r.text)) {
        if (!state.approvalsOff) $.ui.toast(core.isScopeRefusal(r.text) ? core.APPROVALS_OFF_TOAST : core.approvalsRefusedToast(r.text))
        if (state.standby) $.ui.toast(core.STANDBY_NOTICES_OFF_TOAST)
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
    for (const q of answered) $.ui.toast(core.questionToastText(q))
    for (const f of fresh.slice(0, 3)) $.ui.toast(core.toastText(f))
    if (fresh.length > 3) $.ui.toast(`AppHandoff inbox: ${fresh.length - 3} more new message(s)`)

    // The chat's own post can reach the thread before its tool result reaches
    // us; give that result a moment so decideWake can drop the chat's own id.
    if (fresh.length > 0) await $.clock.sleep(core.OWN_WRITE_SETTLE_MS)

    // Claim each ticket a wake would name for the chat (HO-19659) before waking it: someone else's
    // lease means no wake; a claim that failed in passing holds that ticket's wake to the next tick.
    const hold: string[] = []
    if (!state) return
    let claimsStopped = false
    for (const w of core.claimTargets(state, await $.clock.now())) {
      const claimAt = await $.clock.now()
      // A sign-in failure or rate limit ends this tick's claims; the rest wait for the next tick.
      if (claimsStopped) {
        if (core.claimHoldsWake(w, claimAt)) hold.push(core.labelOf(w))
        continue
      }
      const outcome = await claimBeforeWake($, server, w, claimAt)
      if (!state) return
      if (outcome.kind === 'retry') {
        if (core.claimHoldsWake(w, claimAt)) hold.push(core.labelOf(w))
        claimsStopped = state.authStopped || state.retryAt !== null
        continue
      }
      const applied = core.applyClaim(state, w.ref, outcome, claimAt)
      state = applied.state
      if (applied.toast) $.ui.toast(applied.toast)
    }
    if (!state) return
    state = core.pruneClaimToasts(state, hold)

    const decidedAt = await $.clock.now()
    const d = core.decideWake(state, decidedAt, hold)
    state = d.state
    if (d.tripped) $.ui.toast(core.LIMIT_TOAST)
    if (d.wake || d.approvals.length > 0 || d.driven.length > 0 || d.questions.length > 0) {
      submitWake($, core.wakePrompt(d.wake, d.approvals, state.sessionId, d.driven, d.questions), decidedAt)
    }
    // The standing inbox (HO-19660) acts only when nothing else is waking the chat this tick.
    await standbyStep($, server)
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
        description: 'AppHandoff inbox: what this chat watches; pause or resume wakes; standby makes this chat a standing inbox',
        argumentHint: '[pause|resume|standby <project ids>|standby off]',
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
      if (command === 'standby') {
        const req = core.parseStandby(e.args)
        if (req.action === 'invalid') return { text: core.STANDBY_USAGE }
        state = req.action === 'off' ? core.stopStandby(state) : core.startStandby(state, req.projects, now)
        schedule($, 1_000)
      }
      if (command === 'unknown') return { text: `inbox: usage /inbox [pause|resume|standby <project ids>|standby off]` }
      show($)
      await save($)
      return { text: core.describe(state, now) }
    } catch (err) {
      return { text: `inbox: ${err instanceof Error ? err.message : String(err)}` }
    }
  })
}
