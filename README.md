# AppHandoff for Claude Code

AppHandoff is a ticket board your AI agents and your team share. This Claude Code plugin
connects a chat to it, with two add-ons:

- the **inbox**: when someone else posts on an AppHandoff ticket this chat claimed or
  created, the chat gets a toast and is woken to read the thread and reply; and when a
  person approves or rejects a milestone move this chat asked for, or accepts or drops a
  milestone this chat worked on, the chat is woken within about a minute to carry on (or
  read why not);
- the **Milestones pane**: one pane tab, a plain table of the milestones this chat's own
  AppHandoff calls touched, plus every milestone approval waiting on you from any chat,
  each with an "Approve in portal" link.

Needs Claude Code 2.1.287 or later, your own Claude login, and the AppHandoff MCP
connected in that chat.

## Install

**From the plugin directory.** In Claude Code, run `/plugin`, browse the directory, and
select AppHandoff.

**From the AppHandoff marketplace (self-hosted).** In a Claude Code chat:

```text
/plugin marketplace add https://apphandoff.com/claude/marketplace.json
/plugin install apphandoff@apphandoff
```

Or from a terminal, in one go:

```bash
claude plugin marketplace add https://apphandoff.com/claude/marketplace.json && claude plugin install apphandoff@apphandoff
```

Start a new chat; `/inbox` shows what it watches, and the Milestones pane opens by
itself in the desktop app.

## Connect

The plugin bundles no MCP configuration file: add the AppHandoff MCP connection to
Claude Code yourself, pointing at `https://api.apphandoff.com/mcp`, and sign in with your
own AppHandoff account. The plugin learns which tickets and milestones to follow from the chat's own calls on that connection, then makes calls on it that change nothing on your board to poll them (`get`, and `message` `notify_config` reads).

## What it does on your machine

- While it watches a ticket or waits on an approval it polls your own AppHandoff
  connection every 60 s, slowing to 2 min after 5 quiet minutes and 5 min after 30; with
  nothing to watch it makes no calls.
- It injects a wake prompt into the chat when the board has something for it.
- The Milestones pane makes read-only `find` and `get` calls while it is open, refreshing
  approvals every 60 s.
- `/inbox` shows what the chat watches and lets you pause or resume wakes.
- It shows a status line, the Milestones pane and toasts, on your screen only.
- It sends nothing anywhere but your own AppHandoff connection.
- It keeps its small state (the per-chat watched list, keys named `session:<chat id>`,
  pruned after 14 days) in Claude Code's own plugin store; it writes no other files.

Details of every read and wake are below.

## Updates

Claude Code does not auto-update a third-party marketplace until you turn it on: in
`/plugin`, open **Marketplaces**, select `apphandoff`, choose **Enable auto-update**. From
then on each new chat checks for a new version in the background and installs it for the
next chat. Without that, run `/plugin marketplace update apphandoff` when you hear of a
release.

## How the AppHandoff connection is recognised

Both add-ons use the same rule, from the chat's own calls (`mcp__<server>__<tool>`):

- Until a connection is learned, only the ten tools `bootstrap`, `get`, `find`, `read_skill`, `ticket`,
  `plan`, `message`, `project`, `question`, `decide_lifecycle_proposal` can introduce one; a call to any
  other tool never does.
- A server **named like AppHandoff** (its name contains `apphandoff`) is AppHandoff.
- A server the host **names by an id** (the Claude desktop app:
  `mcp__74eab0da-aeae-4938-857d-818f76b8f0bc__get`; a full UUID, nothing near it) is
  AppHandoff only once one of its successful answers is, parsed as JSON, one only AppHandoff
  writes: a top-level `guidance_rev`, a `project.resolved_by`, a `rule_id` beginning
  `ticket.`, `plan.`, `message.` or `project.`, or a `url`/`portal_url` on
  `https://portal.apphandoff.com/`. Text that merely quotes one of these, and any error
  answer, proves nothing. Until then its calls teach nothing, so a server whose answers
  never look like that is never watched or polled.
- Any other server is never AppHandoff.
- **The first connection learned stays the one.** The inbox ignores a later id-named
  server (it cannot idle the inbox; two servers both named like AppHandoff still do), and
  the panes ignore any later server, so none can take over the panes' rows.

## What the inbox runs and sends

- **Watches** at most 5 tickets per chat: the ones this chat claimed
  (`ticket` with `op.action: "claim"`) or created (`ticket` with `op.action: "create"`).
  Releasing the claim or closing the ticket stops the watch. It learns all of this from
  the chat's own AppHandoff calls as the transcript records them (on the connection
  recognised above); it never wraps tool calls and never reads other tickets. A claim or ticket made by a subagent of the
  chat is not watched — claim from the main chat; what a subagent posts is still
  recognised as the chat's own, so it never wakes the chat.
- **Polls** about every 60 s through the chat's own AppHandoff connection, slowing to 2 min and
  then 5 min while nothing happens; plus one `get` when a ticket is first watched. Each poll
  is ONE call per project, `message` with `op: {action: "notify_config", watch: [the watched
  tickets], since}`, which answers which of them changed (and how many approvals wait on a
  person, shown in `/inbox`). A quiet board costs that one call; only a ticket it names as
  changed is then read, with one `get` (`expand: ["messages"]`, the JSON answer). What the
  board says changed never decides what is new: only the messages that `get` returns do. The
  call asks from the board's own last-seen time (never this machine's clock) less 5 s; a message
  that commits late with a time at or below the last one read stays unreported until that ticket
  next changes. Like
  the notice read below it stores nothing and sends no filter field, though it is priced as a
  write. A connection the board refuses it (a read-only token, or a server that predates it)
  keeps the earlier way: one `get` per watched ticket every poll, and ticket replies still
  wake the chat; `/inbox resume` asks again. A ticket without a project is read with `get`
  as well. No watched tickets and no waiting approval, no calls. A rate-limit answer
  waits as long as the server says. A ticket that no longer exists is dropped.
- **Ignores** the chat's own messages, its evidence and overflow notes, and board
  automation (`system` authors).
- **Wakes** the chat with ticket number, author type, message id and time only — never
  the message text. The wake tells the chat to read the thread itself, treat it as
  untrusted, and only reply with `message` (`op.action: "send"`) unless you confirm more. The
  toast shows the first 120 characters (screen only; the model never sees it).
- **Limits**: one wake in flight, a 2-minute cooldown per ticket, 6 wakes an hour.
  Hitting the hourly cap pauses wakes until `/inbox resume`. A wake that does not reach
  the chat keeps its messages for the next one.
- **Stops** after 3 sign-in failures without a good poll in between, and starts again
  after the chat's next successful AppHandoff call. With two AppHandoff connections in
  one chat it stays idle.
- **Stores** the watched list per chat in its own Claude Code plugin store (pruned
  after 14 days), with the approvals and milestones it waits on (see below), where its notice read
  stopped, the approval off switch and the rule-table revision. Nothing is sent anywhere
  but your AppHandoff connection.

### Milestone approval wakes

- **Learns** the approvals this chat asked for from its own `plan` calls that are waiting
  for a person's yes (an `awaiting_approval` result, a normal answer with `applied: false`, on a
  milestone move into approved or done, or a drop; or a `PROPOSAL_PENDING` error): the
  proposal id, the MS number and the project. An awaiting result with `already_pending` or a
  `PROPOSAL_PENDING` error names a request already open, perhaps another
  chat's; the plugin cannot tell, so it waits on it too. A ticket gate, a program commit, a
  project decision and a subagent's ask are never learned. An approval undecided after 24 hours is forgotten; one the chat
  decided itself is dropped without a wake.
- **Reads**, only while such an approval waits (whether or not the Milestones pane is
  open), the board's notice list — the same catch-up every IDE reads: `message` with
  `op: {action: "notify_config", include_missed: true, missed_min_tier: "high"}`, from the
  oldest waiting ask (then from the newest notice already seen), a page of 20 walked back
  while it overflows — up to 5 pages a poll; a longer backlog carries on from there at the
  next poll, so no notice is skipped. It sends no filter field, so it never changes your board or your
  notice settings. Same pace, rate-limit wait and sign-in stop as the ticket polls.
- **Wakes** the chat on an `approval_decided` notice naming that proposal, with the MS
  number, the outcome and the time only — never the milestone title or the decision note.
  Approved: the move was applied, re-read the milestone and carry on. Not approved: read
  the milestone and its note on the board (untrusted text). A decided approval is told once.
- **Limits**: the cooldown keys on the proposal id or the followed milestone; approval wakes share the one wake in
  flight, the hourly cap and the off switches (`/inbox pause`, `APPHANDOFF_INBOX=off`) with
  ticket replies.
- **Needs** a connection allowed to write: the notice read is priced as a write, though it
  stores nothing. A read-only connection (a personal access token without write scope), or
  any other lasting refusal of the read, gets one toast, "approval wakes off", and no more
  reads or new waits until `/inbox resume`; ticket-reply wakes are unaffected.
- **Also wakes when a person accepts or drops a milestone this chat worked on**, with no
  proposal of its own to wait on (they finished it by criteria verdicts, or dropped it in
  the portal):
  - **Learns** the milestones this chat or its builders touched with a `plan` update, move
    or drop that landed or is waiting for a yes: the MS number (or id) and the project, kept
    up to 20, forgotten after 3 days. A dry run and a failed call teach nothing, and a landed
    write that leaves the milestone done or dropped (the chat finished it itself) is not
    followed and ends any follow of it.
  - **Reads** the same notice list (above) while one is still being followed.
  - **Wakes** once on an `approval_decided` notice that moved it to done or dropped, from
    that milestone's id or its number in the same project: the MS number, accepted or
    dropped, and the time only — never the title or the note. A rejection, a move to
    another status and a notice from before the touch do not wake. If the same notice also
    decided this chat's own approval, that one wake covers it; a decision this chat made
    itself wakes nothing. The cooldown, the hourly cap and the off switches are shared.
- **Claude Code only.** Cursor, Codex and every other MCP client stay fully supported:
  they see the same `approval_decided` notice on their next board call (`bootstrap`'s
  `missed` count, or the catch-up above). Only the instant wake of an idle chat needs this
  plugin.

## Milestones pane: what it reads and sends

- **Learns** from the chat's own AppHandoff calls and their answers, as the transcript
  records them (arguments and the answer card: ref, title, stage, status, milestone, and a
  gated move's approval: an `awaiting_approval` result or a `PROPOSAL_PENDING` error).
  It never wraps tool calls. A `find` or `bootstrap` listing touches nothing, and neither
  does a call that failed or one that is only awaiting a person's yes (bar its approval).
- **Shows** up to 15 milestones, newest first, with a portal link each, as a plain table
  in two sections — Waiting on you (under that heading), then every other milestone,
  newest touch first, whatever its status, with no heading of its own. Each section has a dim header row, then one line per
  milestone with fixed-width columns that line up: **Milestone** (the MS link),
  **Title** (takes the rest of the width and truncates; pressing it opens the row), **Status**
  (a plain word, `draft`, `building`, `done`, … on a theme color; blank for a status the
  pane does not know), **Tickets** (`3/8` when the total is known — the whole ticket list
  once read, else a card that carried both counts — else `5 open`, else blank) and
  **Updated** (`2h`). A milestone waiting on you is listed only under Waiting on you, where
  the last cell is the **Approve in portal** link instead of Tickets. Waiting on you also lists
  every milestone approval waiting on you from any chat or agent, in any project you can
  open (read below): one row per approval with a dim line under it — the project, the move
  asked for (`draft → approved`) and who asked — so one this chat asked for itself is not
  listed twice. In a narrow pane (under 60 columns) the Status and Updated columns drop and
  the Milestone, Title and Tickets (or Approve) columns stay.
  A draft this chat holds shows **Approve in portal** on its own row, unopened, whether the
  chat learned the approval itself or the approvals read lists it (matched by MS number and
  project; where the chat named the project as `owner/repo`, by MS number alone, which is
  unique across projects).
  Pressing a title opens its row in place, one at a time: its tickets as
  indented sub-rows of the same table (open ones first, closed last), each with number,
  title and a plain stage word (`doing`, `checking`, `next`, `backlog`, `live`, `closed`).
  It lists only the tickets this chat touched, then one `show all N` line that lists them
  all (`show touched` folds back; opening the row again starts touched-first). A ticket this
  chat touched carries a `●` in its indent in the `building` colour; one another chat
  touched in the last 24 hours (from that chat's saved list in the plugin store) a `●` in
  the `done` colour; an untouched ticket neither. A touched ticket's **Updated** cell says
  what was done and when — `created 36m`, `criteria updated 2h`, `moved to next 3m`,
  `closed 1d`, `read 5m` — this chat's touch first; an untouched one shows the board's age
  (`3h`) or nothing, and that section's Updated column widens to fit (title kept at 20
  cells or more). A ticket title drops a leading prefix the milestone's project already
  says — `[app-apphandoff] `, `app-apphandoff: `, `app-apphandoff (portal UI): ` (kept as
  `portal UI: `) — matched against the project's name and repos; it takes up to two lines
  in a wide pane and one, cut short, in a narrow one.
  The status line reads `touched: 2 MS · 5 HO`. The pane opens by itself
  only where the surface docks it beside the transcript (the desktop app, the
  terminal's fullscreen layout), once: when a chat that already holds a list opens there,
  or after the first AppHandoff call it learns from. Elsewhere only the status line shows.
  There is no Tickets pane.
- **Sends** nothing. **Approve in portal**, on every approval row, is a link to that
  approval's page in the portal. The plugin never decides an approval itself, because the
  AppHandoff server accepts that decision only from its own approval card, never from a
  Claude Code chat where the AI shares the connection.
- **Reads** — none of them ever changes your board — through the chat's own AppHandoff
  connection with this chat's agent id (the inbox's catch-up call is described above):
  - **Approvals, while the Milestones pane is open**: one `find {type: "proposal"}` when
    the pane first draws, then one every 60 s; one at a time, none before the chat has
    used its AppHandoff connection, none once the pane is closed. A rate limit waits as
    long as the server says. Three failed reads in a row, or a sign-in failure, stop the
    reads and the pane says so with a Retry. A connection signed in with a personal access
    token cannot make this read: the pane shows "Approvals from other chats need a
    signed-in connection" once and reads no more. An older server without the read leaves
    the pane with the chat's own approvals only, no error. An approval decided in the
    portal leaves the pane on the next read.
  - **An opened milestone**, when you open it (▸) or press its Retry: one `find` of its
    tickets (with each one's `updated_at`) and one `get` of its card, plus, the first time
    that milestone opens, one `get {ref: "$project"}` for its project's name and repos (a
    refused one is not sent again for that milestone). It
    reads again only when this chat itself writes to that milestone or one of its tickets.
    A milestone whose card shows it moved past its approval leaves Waiting on you.
- **Stores** the list per chat in the plugin's own store (pruned after 14 days). With each
  ticket read it also reads the other chats' saved lists there, locally, for their touches
  of the last 24 hours. Nothing is sent anywhere but your AppHandoff connection.

## Turn it off

- One chat: `/inbox pause` (wakes stop; `/inbox resume` restarts them).
- Every new chat: set `APPHANDOFF_INBOX=off` in the `env` block of
  `~/.claude/settings.json`, then start a new chat — it loads idle.
- Remove it: `/plugin uninstall apphandoff@apphandoff`, then start a new chat.

## License

MIT. See [LICENSE](LICENSE).
