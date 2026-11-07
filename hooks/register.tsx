// AppHandoff for Claude Code — the plugin's hooks module: the inbox add-on
// (HO-16353).
//
// Wakes this chat when someone else posts on a ticket it claimed or created,
// when a person decides a milestone approval it asked for (HO-17707: read
// from the board's notice list, the catch-up every IDE reads), and when a
// person accepts or drops a milestone this chat or its builders worked on
// (HO-19052: followed from its own plan calls, no proposal of its own). Watched
// tickets are polled with one `message` notify_config watch call per project, then
// one `get` per ticket it names as changed (HO-19546); a connection that cannot make
// that call reads every ticket with `get`, as before. A project that also waits on a
// notice read asks for both in that one call (HO-21344). Before it wakes the chat for a new message it
// claims the ticket for the chat (HO-19659: one of the plugin's two board writes, both under the chat's
// own agent id; another agent's lease means no wake), and it wakes the chat when a person answers
// a board question the chat asked. `/inbox standby <project ids>` (HO-19660) makes a chat a standing
// inbox: it claims, one a poll, a message nobody answered six minutes after it was posted
// and wakes the chat for it (a board question for a person's message, a reply-only wake for an outside
// agent's). When the chat ends it tries to release each ticket whose lease the chat still holds: that lands on an
// in-process /clear; after a quit, a closed window or a desktop clear the engine refuses board calls at the end, so the
// next chat started on that computer releases them (HO-21402), and otherwise the lease lapses in 20 minutes. A
// /clear or a resume starts the new chat's inbox under the new chat's own id (HO-21360). Every decision
// lives in ./inbox-core.ts (pure, unit-tested); this file only moves what the
// engine says into it and acts on what it returns. Nothing here may throw
// into the chat: every hook and timer path catches.
//
// The same module also holds `/pg` (HO-24860), the program view: a pane that reads a program's
// milestones and tickets from the board this chat's own AppHandoff calls used (read-only `find`
// calls, only while the pane is open; the numbers are ./program-view.ts's, the drawing is
// ./pg-client.tsx). It is a .tsx file because the pane is drawn here.

import { update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'
import { isTimeout, withCallTimeout } from './call-timeout'
import * as core from './inbox-core'
import * as pv from './program-view'
import { statusWith } from './status-line'
import * as titles from './ticket-titles'

let state: core.InboxState | null = null
let timer: { cancel: () => void } | null = null
/** The pending sweep of ended chats' leases (HO-21402): its own timer, since `schedule` refuses a chat that watches nothing. */
let sweepTimer: { cancel: () => void } | null = null
let polling = false
let off = false
/** A new chat's id (after a /clear or a resume) whose inbox is built once the running poll ends (HO-21360). */
let startAfterTick: string | null = null
/** Arguments of the chat's own AppHandoff calls still awaiting their result, by tool_use id. */
const pendingCalls = new Map<string, core.PendingCall>()

const textOf = (r: McpToolResult) =>
  r.content.map((c) => ('text' in c && typeof c.text === 'string' ? c.text : '')).join('\n')

type Answer = { ok: true; json: unknown } | { ok: false; text: string }

/**
 * One AppHandoff tool call held to the 60 s limit (HO-21343). A top-level function declaration that takes `$`
 * whole and spells each engine call plainly: the plugin directory reads `$` in no other shape (HO-22974).
 */
function callTool($: EngineInterface, server: string, tool: Tool, args: Record<string, unknown>): Promise<McpToolResult> {
  const call = $.mcp.call(server, tool, args)
  return withCallTimeout((ms, fn) => $.clock.after(ms, fn), call)
}

/** Whether a failed poll ends this tick: a sign-in stop, a rate-limit wait, or a call that timed out (a dead link; the next tick tries again). */
const endsTick = (s: core.InboxState, text: string) => s.authStopped || s.retryAt !== null || isTimeout(text)

/** The first content block's text: where a `get` answer carries its JSON when there is no structuredContent. */
const firstTextOf = (r: McpToolResult) => {
  const c = r.content[0]
  return c && 'text' in c && typeof c.text === 'string' ? c.text : undefined
}

/** One thread read: `get {ref, expand: ["messages"]}`, answered as the ticket payload the core reads. */
async function readThread($: EngineInterface, server: string, args: Record<string, unknown>): Promise<Answer> {
  if (state) state = { ...state, calls: state.calls + 1 }
  try {
    const r = await callTool($, server, 'get', args)
    if (r.isError) return { ok: false, text: textOf(r) || 'get failed' }
    const card = core.ticketFromCard(core.v3Json(r.structuredContent, firstTextOf(r)))
    return card ? { ok: true, json: card } : { ok: false, text: 'get returned no ticket card' }
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) }
  }
}

type Tool = 'message' | 'ticket' | 'question' | 'get' | 'find'

/**
 * One board call: its JSON answer when `answers` takes it, else the failure text. A refusal
 * answered as a plain result is a failure too. Never throws.
 */
async function boardCall(
  $: EngineInterface,
  server: string,
  tool: Tool,
  args: Record<string, unknown>,
  answers: (json: unknown) => boolean,
): Promise<Answer> {
  try {
    const r = await callTool($, server, tool, args)
    const json = core.v3Json(r.structuredContent, firstTextOf(r)) ?? core.parseJson(textOf(r))
    if (!r.isError && !(core.isRecord(json) && typeof json.code === 'string' && !answers(json))) return { ok: true, json }
    return { ok: false, text: textOf(r) || JSON.stringify(json ?? 'message failed') }
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * One `message` notify_config read: the notice list (HO-17707, include_missed) or
 * the watch list (HO-19546), or (`tool` ticket) the claim before a wake (HO-19659), or (`tool` question)
 * the standing inbox's open-question check (HO-19660).
 * `answers` says whether a JSON body is the answer asked for. A GUIDANCE_STALE
 * refusal hands back the current revision: one retry with it.
 */
async function callNotify(
  $: EngineInterface,
  server: string,
  argsOf: (s: core.InboxState) => Record<string, unknown>,
  answers: (json: unknown) => boolean,
  tool: Tool = 'message',
): Promise<Answer> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!state) return { ok: false, text: 'inbox stopped' }
    state = { ...state, calls: state.calls + 1 }
    const r = await boardCall($, server, tool, argsOf(state), answers)
    if (r.ok) return r
    const rev = core.staleGuidanceRev(r.text)
    if (!rev || attempt > 0) return r
    if (state) state = { ...state, guidanceRev: rev }
  }
  return { ok: false, text: 'the rule-table revision kept changing' }
}

/**
 * One project's notices, newest first, walked back with next_before while a
 * page overflowed; the cursor moves to the newest notice once the walk ends.
 * A walk the page cap cuts off resumes from where it stopped on the next tick.
 * `first` is the first page when this tick's watch call already carried it (HO-21344).
 */
async function readNotices(
  $: EngineInterface,
  server: string,
  req: core.NoticeRequest,
  now: number,
  first?: core.NoticeFirst,
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
    // The first page came with the watch call, unless what it asked for is no longer what this page asks.
    let list = page === 0 && first && core.sameNoticeAsk(first.ask, asked) ? first.page : null
    if (!list) {
      const r = await callNotify($, server, (s) => core.noticeArgs(asked, s), (j) => core.noticesIn(j) !== null)
      if (!r.ok) return r
      list = core.noticesIn(r.json)
      if (!list) return { ok: false, text: 'notify_config returned no notice list' }
    }
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

async function save($: EngineInterface, s: core.InboxState | null = state, endedAt?: number) {
  if (!s) return
  try {
    await $.store.set(core.STORE_PREFIX + s.sessionId, core.toStored(s, await $.clock.now(), endedAt))
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

/** `notices`: the first notice pages the watch calls carried this tick, for the notice loop to apply (HO-21344). */
type Polled = { fresh: core.Fresh[]; failures: number; stop: boolean; notices: core.NoticeFirst[] }

/** A poll call that failed for now (not a refusal for good): counted, and it ends the tick when the failure says so. */
async function pollCallFailed($: EngineInterface, text: string, now: number, out: Polled): Promise<boolean> {
  out.failures++
  await failed($, text, now)
  out.stop = !state || endsTick(state, text)
  return out.stop
}

/**
 * The reads this tick owes. The watch list names the changed tickets, so a quiet
 * board costs one call. A refusal for good (read-only scope, an older server) or an
 * answer without the list ends the list for this connection: every ticket is read.
 * A project that also owes a notice page asks for both in that one call (HO-21344); a
 * combined call the board refuses, or answers in part, is asked as two calls from then on.
 */
async function planReads($: EngineInterface, server: string, now: number, out: Polled): Promise<core.TicketRead[]> {
  if (!state) return []
  const plain = (scope: 'all' | 'unprojected') => (state ? core.pollPlan(state, scope).map(core.plainRead) : [])
  if (state.watchReadOff) return plain('all')
  const reads = plain('unprojected')
  for (const req of core.watchPlan(state)) {
    let answer: core.WatchAnswer | null = null
    const notice = core.combinedNotice(state, req)
    if (notice) {
      const c = await callNotify($, server, (s) => core.combinedArgs(req, notice, s), (j) => core.combinedIn(j) !== null)
      if (!state) return []
      const both = c.ok ? core.combinedIn(c.json) : null
      if (both) {
        answer = both.watch
        out.notices.push({ ask: notice, page: both.notices })
      } else if (c.ok || core.combinedRefused(c.text)) {
        // A part missing, or a board that cannot take the two keys together: separate calls from now on.
        state = core.stopCombinedReads(state)
      } else if (!core.isLastingRefusal(c.text) && (await pollCallFailed($, c.text, now, out))) {
        return []
      }
      // Any other failure that does not end the tick (a passing fault, or a refusal that says nothing about
      // combining) leaves combining on: this tick asks the watch and the notice read on their own.
    }
    if (!answer) {
      const r = await callNotify($, server, (s) => core.watchArgs(req, s), (j) => core.watchIn(j) !== null)
      if (!state) return []
      if (!r.ok && !core.watchRefused(r.text)) {
        if (await pollCallFailed($, r.text, now, out)) return []
        continue
      }
      answer = r.ok ? core.watchIn(r.json) : null
    }
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
      if (!state || endsTick(state, r.text)) {
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
  // Settled for the chat that sent it: after a /clear or a resume (HO-21360) it is not the new chat's.
  const sessionId = state?.sessionId
  $.prompt
    .submit({ text })
    .then(
      (r) => !('drop' in r && r.drop !== undefined),
      () => false,
    )
    .then(async (entered) => {
      if (!state || state.sessionId !== sessionId) return
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
        const text = r.ok ? `${w.ref}: no ticket returned` : r.text
        await failed($, text, now)
        if (!state || endsTick(state, text)) return
        break
      }
      state = core.applyBaseline(state, w.ref, r.json)
    }

    // One watch call per project names the changed tickets; each is read with one `get`
    // (all of them, one `get` apiece, when the board answers no watch list).
    const polled: Polled = { fresh: [], failures: 0, stop: false, notices: [] }
    await readTickets($, server, await planReads($, server, now, polled), now, polled)
    if (polled.stop || !state) return
    const fresh = polled.fresh
    failures += polled.failures
    // Milestone approvals this chat asked for: one notice read per project while one waits.
    const decided: core.ApprovalWait[] = []
    const settled: core.DrivenMilestone[] = []
    const answered: core.QuestionWait[] = []
    for (const req of core.noticePlan(state)) {
      const r = await readNotices($, server, req, now, polled.notices.find((f) => f.ask.projectId === req.projectId))
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
      if (!state || endsTick(state, r.text)) return
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
    let linkDead = false
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
        claimsStopped = endsTick(state, outcome.text)
        linkDead ||= isTimeout(outcome.text)
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
    // A call that timed out ends the tick's board calls: the standing inbox's turn waits for the next tick.
    if (!linkDead) await standbyStep($, server)
  } catch (err) {
    if (state) state = { ...state, lastError: err instanceof Error ? err.message : String(err) }
  } finally {
    polling = false
    try {
      show($)
      await save($)
      if (state) schedule($, core.pollIntervalMs(state, now || (await $.clock.now())))
      if (startAfterTick) {
        const sessionId = startAfterTick
        startAfterTick = null
        await start($, sessionId)
      }
    } catch {}
  }
}

/** This chat's inbox, from what the store kept under its id, and its first poll; stale keys are pruned. */
async function start($: EngineInterface, sessionId: string) {
  off = core.isOff(await $.env.get('APPHANDOFF_INBOX'))
  titlesOff = core.isOff(await $.env.get('APPHANDOFF_TICKET_TITLES'))
  titleHydration = null
  titleRetryAt = 0
  resetProgramView()
  const now = await $.clock.now()
  const own = await $.store.get(core.STORE_PREFIX + sessionId)
  pendingCalls.clear()
  state = core.fromStored(sessionId, core.expired(own, now) ? undefined : own, now)
  // A resumed chat already knows its connection: the cached titles reach the drawing now.
  syncTitles($)
  const startNo = ++sweepStart
  sweepTimer?.cancel()
  sweepTimer = null
  // A chat that starts again under an ended id (a resume) drops the mark at once, so no other chat's sweep releases its leases.
  if (!core.expired(own, now) && core.endedAtOf(own) !== null) await save($)
  if (off) return
  for (const key of await $.store.keys()) {
    if (key.startsWith(core.STORE_PREFIX) && key !== core.STORE_PREFIX + sessionId) {
      if (core.expired(await $.store.get(key), now)) await $.store.delete(key)
    }
  }
  show($)
  schedule($, 1_000)
  armSweep($, sessionId, 1, SWEEP_FIRST_MS, startNo)
}

const SWEEP_FIRST_MS = 5_000
const SWEEP_RETRY_MS = 30_000
const SWEEP_ATTEMPTS = 4

/** Counts the starts: a sweep from an earlier start arms nothing more once a newer one has begun. */
let sweepStart = 0

function armSweep($: EngineInterface, sessionId: string, attempt: number, ms: number, startNo: number) {
  sweepTimer?.cancel()
  sweepTimer = $.clock.after(ms, () => void sweepEnded($, sessionId, attempt, startNo))
}

/**
 * Release the leases of chats that ended (HO-21402): a chat's process ending leaves its `session.end` release refused
 * (no session is bound), so this chat, started later on the same computer, sends it under the ended chat's agent id
 * (`cc:<id>`: the claim belongs to the connection, not to the chat). One attempt: every other entry marked ended
 * that holds a live lease on one server is released with releaseHeld and written back with the mark kept (unless a
 * resume cleared it meanwhile). When releases were sent and none landed (the session not bound yet), the next attempt
 * is 30 s later, at most 4 in all. Never throws.
 */
async function sweepEnded($: EngineInterface, sessionId: string, attempt: number, startNo: number) {
  if (startNo === sweepStart) sweepTimer = null
  if (off) return
  try {
    const now = await $.clock.now()
    const entries: [string, unknown][] = []
    for (const key of await $.store.keys()) {
      if (key.startsWith(core.STORE_PREFIX) && key !== core.STORE_PREFIX + sessionId) entries.push([key, await $.store.get(key)])
    }
    let sent = 0
    let landed = 0
    for (const { state: ended } of core.endedToRelease(entries, core.STORE_PREFIX + sessionId, now)) {
      const released = await releaseHeld($, ended)
      sent += core.heldLeases(ended, now).length
      landed += core.heldLeases(ended, now).length - core.heldLeases(released, now).length
      if (released === ended) continue
      // A resume may have cleared the mark while the releases were out: then the entry is a live chat's, left as it is.
      const key = core.STORE_PREFIX + ended.sessionId
      const endedAt = core.endedAtOf(await $.store.get(key))
      if (endedAt !== null) await save($, released, endedAt)
    }
    if (sent > 0 && landed === 0 && attempt < SWEEP_ATTEMPTS && startNo === sweepStart && !off) {
      armSweep($, sessionId, attempt + 1, SWEEP_RETRY_MS, startNo)
    }
  } catch {}
}

/**
 * Release each ticket whose lease a chat still holds, all at once, so the next agent is not refused the ticket
 * for the rest of the 20 minutes (HO-21360). It lands at the end only on an in-process /clear; when the process
 * ends (a quit, a closed window, a desktop clear) the engine refuses every board call there ("no session is
 * bound in this process"), and the next chat started on that computer releases it instead, from its sweep
 * (HO-21402); otherwise the lease lapses in 20 minutes. A release that fails or is cut off leaves that lease to
 * lapse on its own. Works on the given chat's state, never the module's; answers that state with the released
 * leases cleared.
 */
async function releaseHeld($: EngineInterface, ending: core.InboxState): Promise<core.InboxState> {
  const server = core.activeServer(ending)
  if (!server) return ending
  const release = async (w: core.Watched) => {
    const r = await boardCall($, server, 'ticket', core.releaseArgs(w, ending), () => false)
    const rev = r.ok ? null : core.staleGuidanceRev(r.text)
    return rev ? (await boardCall($, server, 'ticket', core.releaseArgs(w, { ...ending, guidanceRev: rev }), () => false)).ok : r.ok
  }
  const held = core.heldLeases(ending, await $.clock.now())
  const released = await Promise.all(held.map(release))
  return held.reduce((s, w, i) => (released[i] ? core.holdLease(s, w.ref, null) : s), ending)
}

// ── ticket titles (HO-22951) ─────────────────────────────────────────────
//
// A reply's `HO-n`, `MS-n` and `PG-n` are drawn with the title (a program's name) and a dot of their kind beside
// them (HO-22968; ./ticket-titles.ts decides the text). Cache keys keep the `ticket-title:` prefix and the state key `ticketTitles`.
// The ids are collected here, off the drawing path, from the assistant rows as they are appended; the
// ones no cache knows are asked of the board in batches of 10 (`get {refs, view: 'card'}`, a read) on
// the connection the inbox learned; the answers are cached across chats in `$.store` (keys
// `ticket-title:HO-n`, never `session:`, so the inbox's sweeps leave them alone) and handed to the
// drawing through `$.state`, which redraws the messages that read it. A drawing never writes state and
// never waits on the board. `APPHANDOFF_TICKET_TITLES=off`, no learned connection, or the inbox
// itself off: no lookup, ids draw as they are.

/** The drawing's titles: `$.state` (`apphandoff-state.d.ts`), the one value the drawing reads. */
const TITLES = { plugin: 'apphandoff', key: 'ticketTitles' } as const

let titlesOff = false
/** What this process knows by ref, with the time it was learned: the shortened title, or null for a ref the board did not answer (negative cache). The TTLs apply on read. */
const titleKnown = new Map<string, titles.StoredTitle>()
/** Refs queued or being asked, so a reply that repeats an id asks once. */
const titleAsking = new Set<string>()
/** The cached titles' one load into the drawing's state, per chat. */
let titleHydration: Promise<void> | null = null
/** A failed lookup (not a not-found) holds every lookup until this time. */
let titleRetryAt = 0
/** Lookups run one after another. */
let titleQueue: Promise<void> = Promise.resolve()

/** The AppHandoff connection titles are read through: the inbox's learned one, and none while either is off. */
const titleServer = () => (titlesOff || off || !state ? null : core.activeServer(state))

/** The cached titles, not yet expired, into the drawing's state; expired entries are swept. */
async function hydrateTitles($: EngineInterface) {
  const now = await $.clock.now()
  const found: titles.Titles = {}
  for (const key of await $.store.keys()) {
    if (!key.startsWith(titles.STORE_PREFIX)) continue
    const entry = titles.fromStored(await $.store.get(key), now)
    if (!entry) {
      await $.store.delete(key)
      continue
    }
    const ref = key.slice(titles.STORE_PREFIX.length)
    titleKnown.set(ref, entry)
    if (entry.title) found[ref] = entry.title
  }
  if (Object.keys(found).length > 0) await update($, TITLES, (current) => titles.mergeTitles(current, found))
}

/**
 * One batch: the shortened title of each ref the board answered with a card, null for each it
 * answered without one. A batch the board fails whole as not found is asked ref by ref (one gone
 * ref must not hide the others); any other failure holds lookups for a while and answers nothing.
 */
async function askBatch($: EngineInterface, server: string, batch: string[]): Promise<Record<string, string | null>> {
  const r = await boardCall($, server, 'get', titles.lookupArgs(batch), titles.isGetAnswer)
  if (r.ok) return titles.readAnswer(r.json, batch) ?? {}
  if (titles.isGone(r.text)) {
    if (batch.length === 1) return { [batch[0] as string]: null }
    const out: Record<string, string | null> = {}
    for (const ref of batch) {
      const before = titleRetryAt
      Object.assign(out, await askBatch($, server, [ref]))
      // Another kind of failure holds lookups: the rest of the batch waits too.
      if (titleRetryAt !== before) break
    }
    return out
  }
  titleRetryAt = (await $.clock.now()) + (core.retryAfterMs(r.text) ?? titles.RETRY_MS)
  return {}
}

/** Asks the board for `ask` in batches, caches each answer, then hands the new titles to the drawing. Never throws. */
async function askTitles($: EngineInterface, server: string, ask: string[]) {
  try {
    for (const batch of titles.batches(ask)) {
      if (titleServer() !== server || (await $.clock.now()) < titleRetryAt) return
      const answered = await askBatch($, server, batch)
      const now = await $.clock.now()
      const found: titles.Titles = {}
      for (const [ref, title] of Object.entries(answered)) {
        titleKnown.set(ref, titles.toStored(title, now))
        try {
          await $.store.set(titles.STORE_PREFIX + ref, titles.toStored(title, now))
        } catch {}
        if (title) found[ref] = title
      }
      if (Object.keys(found).length > 0) await update($, TITLES, (current) => titles.mergeTitles(current, found))
    }
  } catch {
  } finally {
    for (const ref of ask) titleAsking.delete(ref)
  }
}

/**
 * Called as rows are appended: loads the cache into the drawing once the connection is learned, and
 * looks up the ids in `text` (an assistant reply) that no cache knows. Fire and forget; never throws.
 */
function syncTitles($: EngineInterface, text?: string) {
  try {
    const server = titleServer()
    if (!server) return
    // A load that failed is tried again on the next row.
    titleHydration ??= hydrateTitles($).catch(() => {
      titleHydration = null
    })
    const refs = text ? titles.refsIn(text) : []
    if (refs.length === 0) return
    // The `$` of this hook is used after it returns, as the inbox's timers (`schedule` from `learn`) and
    // `submitWake` already do, and as the reference's own `session.start` example does for a loop that runs on.
    void titleHydration
      .then(async () => {
        const now = await $.clock.now()
        const fresh = { has: (ref: string) => titles.fromStored(titleKnown.get(ref), now) !== null }
        const ask = titles.unknownRefs(refs, fresh, titleAsking)
        if (ask.length === 0) return
        for (const ref of ask) titleAsking.add(ref)
        titleQueue = titleQueue.then(() => askTitles($, server, ask))
      })
      .catch(() => {})
  } catch {}
}

// ── program view, /pg (HO-24860) ─────────────────────────────────────────
//
// `/pg [PG-n]` opens the `pg-view` pane: one program's progress and its milestones, read from the board
// the chat's own AppHandoff calls used (the connection the inbox learned, the project the chat's calls
// named most recently; with no such call yet the pane says so and calls nothing). All reads are `find`
// calls, which change nothing: the programs and the milestones with their pending approvals (and the
// open tickets of each milestone still moving) when /pg runs or the pane first draws, on Refresh, and
// every 60 s while the pane is open (its client module asks); a milestone's tickets when its number is
// pressed (and with each refresh while that list is open). The numbers are ./program-view.ts's.

const PG_PANE = 'pg-view'
const MS_PANE = 'ms-view'
const NO_CALL = 'Make an AppHandoff call in this chat first (for example, ask Claude to look up a ticket), then open /pg again. Nothing is read until then.'

/** What one board's program view has read: the last good read of each part stays while a refresh runs. */
type PgView = {
  /** The board it was read from (connection and project); another board starts a new view. */
  key: string
  /** undefined: not read yet; null: the read failed. */
  programs: pv.Pg[] | null | undefined
  milestones: Map<string, pv.Ms[] | null>
  readAt: Map<string, number>
  /** The portal page of each milestone approval waiting on a person. */
  approvals: Map<string, string>
  tickets: Map<string, pv.Tk[] | null>
  /** Reads running now ('*' for the programs, else a PG or MS number). */
  loading: Set<string>
  /** Reads started for this board ('load' for the first draw, else a PG number): a draw reads a part once. */
  asked: Set<string>
  /** Failed first reads waiting for their retry ('*' for the programs, else a PG number). */
  retrying: Set<string>
}

/** Where a read goes: the connection and the project (null: the connection resolves it, as it did for the chat). */
type Target = { server: string; project: string | null }

const freshView = (key: string): PgView => ({
  key,
  programs: undefined,
  milestones: new Map(),
  readAt: new Map(),
  approvals: new Map(),
  tickets: new Map(),
  loading: new Set(),
  asked: new Set(),
  retrying: new Set(),
})

/** The projects this chat's own AppHandoff calls used, most recent first. Memory only: a new chat starts empty. */
let usedProjects: string[] = []
/** Whether this chat has made an AppHandoff call since it started: a connection restored from the store is not enough. */
let chatCalled = false
let pgView: PgView = freshView('')
/** The program the pane shows, and the milestone its ticket list shows. */
let pgProgram: string | null = null
let pgMilestone: string | null = null

function resetProgramView() {
  usedProjects = []
  chatCalled = false
  pgView = freshView('')
  pgProgram = null
  pgMilestone = null
}

/** The board /pg reads now. */
const pgBoard = (): pv.BoardPick => pv.pickBoard(state?.servers ?? [], usedProjects, chatCalled, off)

/** The view of a board; a different board (another project the chat moved to) drops what the last one read. */
function viewOf(key: string): PgView {
  if (pgView.key !== key) {
    pgView = freshView(key)
    pgMilestone = null
  }
  return pgView
}

/** Why there is nothing to read, in words. */
function pgNothing(pick: pv.BoardPick): string {
  if (pick.kind === 'ambiguous') return 'This chat has used more than one AppHandoff connection, so /pg cannot tell which board to read.'
  return off ? 'The AppHandoff add-on is off (APPHANDOFF_INBOX=off), so /pg cannot tell which board this chat uses.' : NO_CALL
}

/** Every item of a `find`, page by page, up to `cap`. Throws when the board refuses or fails. */
async function findAll($: EngineInterface, t: Target, args: Record<string, unknown>, cap = 500): Promise<unknown[]> {
  const out: unknown[] = []
  let cursor: string | undefined
  do {
    const ask = { ...(t.project ? { project_id: t.project } : {}), limit: 100, max_bytes: 16384, ...args, ...(cursor ? { cursor } : {}) }
    const r = await boardCall($, t.server, 'find', ask, (j) => core.isRecord(j) && Array.isArray(j.items))
    if (!r.ok) throw new Error(r.text)
    if (!core.isRecord(r.json)) throw new Error('find returned no list')
    if (Array.isArray(r.json.items)) out.push(...r.json.items)
    cursor = typeof r.json.next_cursor === 'string' && r.json.next_cursor !== '' ? r.json.next_cursor : undefined
  } while (cursor && out.length < cap)
  return out
}

function some<T>(x: T | null): x is T {
  return x !== null
}

/** Ask the pane to draw again; a refused or failed redraw is not worth an unhandled rejection. */
async function redraw($: EngineInterface): Promise<void> {
  try {
    await $.ui.invalidate('ui.render')
  } catch {}
}

/** Reads of one milestone's tickets run this many at a time. */
const TICKET_READS_AT_ONCE = 4
/** A failed first read is tried again after this long, while the pane is open (the drawing that would ask is not on screen). */
const RETRY_MS = 60_000

async function retryRead($: EngineInterface, v: PgView, key: string, again: () => Promise<void>): Promise<void> {
  v.retrying.delete(key)
  if (pgView === v && (await paneOpen($, PG_PANE))) await again()
}

function retryLater($: EngineInterface, v: PgView, key: string, again: () => Promise<void>) {
  if (v.retrying.has(key)) return
  v.retrying.add(key)
  $.clock.after(RETRY_MS, () => void retryRead($, v, key, again))
}

async function fetchPrograms($: EngineInterface, t: Target, v: PgView): Promise<void> {
  if (v.loading.has('*')) return
  v.loading.add('*')
  try {
    v.programs = (await findAll($, t, { type: 'program' }, 300)).map(pv.programFrom).filter(some)
  } catch {
    v.programs = v.programs ?? null
    if (v.programs === null) retryLater($, v, '*', () => loadProgram($, t, v))
  } finally {
    v.loading.delete('*')
    await redraw($)
  }
}

/**
 * One read of a program: its milestones, the pending approvals (a refused proposal read, OAuth-only,
 * draws the pane without approve flags) and the open tickets of each milestone still moving (to count
 * what is in progress and which wait on a decision). The last good read stays on screen while it runs.
 */
async function fetchMilestones($: EngineInterface, t: Target, v: PgView, pg: string): Promise<void> {
  if (v.loading.has(pg)) return
  v.asked.add(pg)
  v.loading.add(pg)
  await redraw($)
  try {
    const items = await findAll($, t, { type: 'milestone', filter: { program: pg } })
    // Without a project the proposal read would list every project the sign-in can reach, and a bare
    // MS-n would flag a milestone of another project: no project named, no approval flags.
    const proposals = t.project ? await findAll($, t, { type: 'proposal' }, 100).catch(() => []) : []
    const { pending, urls } = pv.proposalsFrom(proposals)
    const read = await pv.mapLimit(items, TICKET_READS_AT_ONCE, async (item) => {
      const ref = pv.ticketsToRead(item)
      const open = ref ? (await findAll($, t, { type: 'ticket', filter: { milestone: ref, stage: pv.OPEN_STAGES } }, 200)).map(pv.ticketFrom).filter(some) : []
      return pv.milestoneFrom(item, open, pending)
    })
    v.approvals = urls
    v.milestones.set(pg, read.filter(some))
    v.readAt.set(pg, await $.clock.now())
  } catch {
    if (!v.milestones.get(pg)) {
      v.milestones.set(pg, null)
      retryLater($, v, pg, () => fetchMilestones($, t, v, pg))
    }
  } finally {
    v.loading.delete(pg)
    await redraw($)
  }
}

async function fetchTickets($: EngineInterface, t: Target, v: PgView, ms: string): Promise<void> {
  if (v.loading.has(ms)) return
  v.loading.add(ms)
  try {
    // Archived tickets are shipped work too: the list matches the shipped count in the header.
    v.tickets.set(ms, (await findAll($, t, { type: 'ticket', filter: { milestone: ms, include_archived: true } })).map(pv.ticketFrom).filter(some))
  } catch {
    if (!v.tickets.get(ms)) v.tickets.set(ms, null)
  } finally {
    v.loading.delete(ms)
    await redraw($)
  }
}

/** The programs, then the milestones of the one shown (the one asked for, else the board's first). */
async function loadProgram($: EngineInterface, t: Target, v: PgView): Promise<void> {
  v.asked.add('load')
  await fetchPrograms($, t, v)
  const pg = pgProgram ?? v.programs?.[0]?.ref
  if (pg) await fetchMilestones($, t, v, pg)
}

/** Whether one of this plugin's panes is open now: the engine's record. A failed look counts as closed. */
async function paneOpen($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.ui.panes()).some((p) => p.id === id)
  } catch {
    return false
  }
}

async function showProgram($: EngineInterface, pg: string | undefined): Promise<string> {
  if (pg) pgProgram = pg
  const pick = pgBoard()
  if (pick.kind === 'ok') void loadProgram($, pick, viewOf(pick.key))
  await $.ui.open({ id: PG_PANE, title: 'Program view' })
  if (pick.kind !== 'ok') return pgNothing(pick)
  return pg ? `Program view opened on ${pg}.` : 'Program view opened.'
}

async function showMilestone($: EngineInterface, t: Target, v: PgView, ms: string): Promise<void> {
  pgMilestone = ms
  void fetchTickets($, t, v, ms)
  await $.ui.open({ id: MS_PANE, title: ms })
}

/**
 * The plugin's one hooks module (hooks.json names one per plugin): the inbox, and the /pg program view.
 * It draws the status line through ./status-line.ts and decides which server
 * is AppHandoff in ./apphandoff-server.ts. Its ticket titles (HO-22951) are
 * drawn by the `ui.render` hook below from the cache above.
 */
export const register: Register = (on) => {
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
      await $.command.register({
        name: 'pg',
        description: 'AppHandoff program view: progress and milestones of a program, read from the board this chat uses',
        argumentHint: '[PG-n]',
      })
    } catch {}
    try {
      await start($, await $.session.id())
    } catch {}
    return result
  })

  // The chat ends: on exit, and on a /clear or a resume, after which the process goes on under a new
  // chat id with no `session.start` (HO-21360). Its inbox stops before the first wait, so a poll still
  // running claims and wakes nothing more; then its leases are released and its state saved, before
  // the engine's end step. An end that names another chat touches nothing of this one's.
  on('session.end', async ($, e, next) => {
    if (startAfterTick === e.sessionId) startAfterTick = null
    const ending = state?.sessionId === e.sessionId ? state : null
    if (ending) {
      timer?.cancel()
      timer = null
      state = null
    }
    try {
      if (ending && !off) {
        // Marked ended first (HO-21402): when the process is ending the release below is refused, and the next chat's sweep reads this mark.
        const endedAt = await $.clock.now()
        await save($, ending, endedAt)
        const released = await releaseHeld($, ending)
        if (released !== ending) await save($, released, endedAt)
      }
    } catch {}
    return next(e)
  })

  // A /clear or a resume names the new chat here: its inbox starts from what the store kept under its id,
  // once a poll still running for the ended chat has finished. The newest chat wins over a start still waiting.
  // The engine's answer passes through untouched: `return next(e)`, never read or changed (HO-22974).
  on('classic.SessionStart', async ($, e, next) => {
    try {
      const sessionId = e.session_id || (await $.session.id())
      if (sessionId && sessionId !== state?.sessionId && (e.source === 'clear' || e.source === 'resume')) {
        startAfterTick = polling ? sessionId : null
        if (!polling) await start($, sessionId)
      }
    } catch {}
    return next(e)
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
      // The project the chat's own call used, for /pg (a subagent's calls are not the chat's).
      if (scope === 'chat' && state && pv.serverOfTool(seen.tool, state.servers)) {
        chatCalled = true
        usedProjects = pv.rememberProject(usedProjects, pv.projectOfCall(seen, state.servers))
      }
    }
    // The reply's ticket ids, now that this row may have taught the connection (HO-22951). A subagent's text is not drawn here.
    if (e.agentId === undefined) syncTitles($, e.door === 'response' ? core.toolResultText(e.message.content) : undefined)
    return result
  })

  // A reply's ticket ids drawn with their titles (HO-22951): display only, the stored message is untouched.
  // The drawing reads the cache from `$.state` (never writes it, never waits on the board) and redraws when a title lands.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    let text: string | null = null
    try {
      if (titles.wantsNoHighlight(e.props.text)) text = titles.stripNoHighlight(e.props.text)
      else if (!titlesOff && titles.mayHaveRefs(e.props.text)) {
        const { value } = await $.state.get(TITLES)
        const drawn = value ? titles.rewrite(e.props.text, value) : e.props.text
        if (drawn !== e.props.text) text = drawn
      }
    } catch {}
    return text === null ? next(e) : next({ ...e, props: { ...e.props, text } })
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

  // /pg [PG-n] opens the program view pane (HO-24860); the pane reads the board, this only opens it.
  on('command.run', { command: 'pg' }, async ($, e) => {
    try {
      return { text: await showProgram($, e.args.match(/PG-\d+/i)?.[0]?.toUpperCase()) }
    } catch (err) {
      return { text: `pg: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  // The program view pane: a program picker, Refresh, and the drawing (./pg-client.tsx).
  on('ui.render', { component: 'Pane', requestId: PG_PANE }, async ($, e) => {
    const { Box, Text, Button, Select, Client } = $.ui.resolve(e)
    if (e.surface !== 'desktop' && e.surface !== 'terminal') {
      return <Text dimColor>The program view draws on the desktop app and terminal only.</Text>
    }
    const pick = pgBoard()
    if (pick.kind !== 'ok') return <Text dimColor>{pgNothing(pick)}</Text>
    const v = viewOf(pick.key)
    // A pane drawn without /pg having run (it stayed up from an earlier chat) reads once.
    if (!v.asked.has('load')) void loadProgram($, pick, v)
    if (v.programs === undefined) return <Text dimColor>Loading programs…</Text>

    const list = v.programs ?? []
    const pg = list.find((p) => p.ref === pgProgram)?.ref ?? list[0]?.ref ?? null
    if (pg && !v.asked.has(pg)) void fetchMilestones($, pick, v, pg)
    const ms = pg ? v.milestones.get(pg) : undefined
    const meta = list.find((p) => p.ref === pg)
    const sums = ms ? pv.totals(ms) : null
    const split = ms ? pv.splitMilestones(ms) : null

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" columnGap={1}>
          {pg && (
            <Select
              key="pg-pick"
              label="Program"
              value={pg}
              options={list.map((p) => ({ value: p.ref, label: `${p.ref} ${p.name}` }))}
              onSelect={(chosen: string) => {
                pgProgram = chosen
                if (!pgView.milestones.has(chosen)) void fetchMilestones($, pick, v, chosen)
                else void redraw($)
              }}
            />
          )}
          <Button key="pg-refresh" label="Refresh" onPress={() => void loadProgram($, pick, v)} />
        </Box>
        {v.programs === null && <Text dimColor>Could not read the programs from the board.</Text>}
        {v.programs !== null && !pg && <Text dimColor>No programs on this board.</Text>}
        {pg && ms === undefined && <Text dimColor>Loading {pg} milestones…</Text>}
        {pg && ms === null && <Text dimColor>Could not read {pg} from the board.</Text>}
        {pg && ms && sums && split && (
          <Client
            key={`pg-${pg}`}
            module="./pg-client.tsx"
            props={{
              ref: pg,
              name: meta?.name ?? pg,
              ...(meta?.headline ? { headline: meta.headline } : {}),
              percent: sums.percent,
              shipped: sums.shipped,
              total: sums.total,
              bar: pv.barWidths(sums.shipped, sums.active, sums.total),
              inFlight: split.inFlight.map(pv.rowOf),
              finished: split.finished.map(pv.rowOf),
              updatedAt: v.readAt.get(pg) ?? 0,
              refreshing: v.loading.has(pg),
            }}
          />
        )}
      </Box>
    )
  })

  // The program view asks for a re-read every minute (only while its pane is open), or for a milestone's tickets.
  on('ui.message', async ($, e, next) => {
    if (!e.module.endsWith('pg-client.tsx')) return next(e)
    try {
      const msg = pv.messageFrom(e.data)
      const pick = pgBoard()
      if (pick.kind === 'ok') {
        const v = viewOf(pick.key)
        if (msg.refresh && (await paneOpen($, PG_PANE))) {
          void fetchMilestones($, pick, v, msg.refresh)
          if (pgMilestone && (await paneOpen($, MS_PANE))) void fetchTickets($, pick, v, pgMilestone)
        }
        if (msg.open) await showMilestone($, pick, v, msg.open)
      }
    } catch {}
    return {}
  })

  // A milestone's tickets, open ones first by stage, shipped ones dimmed; a ticket opens on the portal.
  on('ui.render', { component: 'Pane', requestId: MS_PANE }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const pick = pgBoard()
    if (pick.kind !== 'ok') return <Text dimColor>{pgNothing(pick)}</Text>
    const v = viewOf(pick.key)
    const ref = pgMilestone
    if (!ref) return <Text dimColor>No milestone selected.</Text>
    const tickets = v.tickets.get(ref)
    const m = [...v.milestones.values()].flatMap((x) => x ?? []).find((x) => x.ref === ref)
    const { open, shipped } = pv.splitTickets(tickets ?? [])
    const stageColor: Record<string, string> = { in_progress: 'yellow', validation: 'yellow', up_next: 'cyan', backlog: 'gray' }

    const item = (t: pv.Tk, quiet: boolean) => (
      <Box key={`ms-row-${t.ref}`} flexDirection="row" columnGap={1}>
        <Link key={`ms-open-${t.ref}`} href={pv.ticketUrl(t.ref) ?? pv.PORTAL} label={t.ref} />
        <Box width={12} flexShrink={0}>
          <Text color={quiet ? undefined : stageColor[t.stage]} dimColor={quiet}>
            {t.stage.replace('_', ' ')}
          </Text>
        </Box>
        <Box flexShrink={1}>
          <Text wrap="truncate-end" dimColor={quiet}>
            {t.type === 'decision_needed' && !quiet ? <Text color="magenta">⚑ </Text> : ''}
            {t.title}
          </Text>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>
            {ref}
            {m ? ` · ${m.title}` : ''}
          </Text>
          {m && (
            <Text dimColor>
              {m.status} · {m.shipped} of {m.total} shipped · {m.active} in progress
            </Text>
          )}
        </Box>
        <Box flexDirection="row" columnGap={2}>
          {v.approvals.has(ref) && <Link href={v.approvals.get(ref) ?? pv.PORTAL} label="⚑ Review approval" />}
          <Link href={`${pv.PORTAL}${ref}`} label="Open in portal" />
        </Box>
        {tickets === undefined && <Text dimColor>Loading tickets…</Text>}
        {tickets === null && <Text dimColor>Could not read {ref} tickets.</Text>}
        {tickets && (
          <Box flexDirection="column">
            <Text bold>Open · {open.length}</Text>
            {open.length ? open.map((t) => item(t, false)) : <Text dimColor>Nothing open.</Text>}
          </Box>
        )}
        {shipped.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Shipped · {shipped.length}</Text>
            {shipped.map((t) => item(t, true))}
          </Box>
        )}
      </Box>
    )
  })
}
