# AppHandoff for Claude Code

AppHandoff is a ticket board your AI agents and your team share. This Claude Code plugin
connects a chat to it with the **inbox**: when someone else posts on an AppHandoff ticket
this chat claimed or created, the chat gets a toast and is woken to read the thread and
reply (or, when a person posted, to ask you what to do through a board question). It also
wakes the chat when a person decides a milestone move this chat asked for, accepts or drops
a milestone this chat worked on, or answers a board question this chat asked.

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

Start a new chat; `/inbox` shows what it watches.

## Connect

The plugin bundles no MCP configuration file: add the AppHandoff MCP connection to
Claude Code yourself, pointing at `https://api.apphandoff.com/mcp`, and sign in with your
own AppHandoff account. The tools it serves are the ones Claude Code shows for that connection.

The plugin learns which tickets and milestones to follow from the chat's own calls on that
connection, then polls them with calls that change nothing on your board. It makes two
calls that do change your board: before it wakes the chat for a new message it **claims
the ticket** for the chat, so two agents never work one ticket at once, and it **releases**
each ticket the chat still holds so the next agent can pick it up at once: when the chat ends
on a `/clear`, and, after you quit or close the window or clear in the desktop app, when the
next chat you start on that computer runs (within seconds of starting). Otherwise the lease
lapses in 20 minutes (standby's claims are always left to lapse). That needs a
connection allowed to write; a read-only one is refused the claim once and then wakes as
before. A person's message is never claimed for, so it always reaches the chat. The one
exception is **standby**, which you turn on yourself: it claims for a person's message too.

## What it does on your machine

- While it watches a ticket or waits on an approval, or while standby is on, it polls your own
  AppHandoff connection every 60 s, slowing to 2 min after 5 quiet minutes and 5 min after 30;
  with nothing to watch it makes no calls. Standby polls with no ticket watched: it reads the
  notice list of the projects you named.
- It injects a wake prompt into the chat when the board has something for it. A wake carries
  ticket number, author type, message id and time only, never the message text. Limits: one
  wake in flight, a 2-minute cooldown per ticket, 6 wakes an hour.
- It claims a ticket for the chat (one `ticket` claim call, a write on your board) before waking
  it for a new message on that ticket (standby, which is off unless you turn it on, claims for a
  person's message too and also makes `question` list reads), and releases each ticket the chat
  still holds (one `ticket` release call each): when the chat ends on a `/clear`, or, after a
  quit, a closed window or a desktop clear, when the next chat started on that computer runs
  (otherwise the lease lapses in 20 minutes); nothing else it sends changes your board. To make
  that possible it marks a chat's saved state with the time the chat ended.
- `/inbox` shows what the chat watches and lets you pause or resume wakes; `/inbox standby
  <project ids>` (off unless you run it) makes the chat a standing inbox for those projects.
- It shows a status line and toasts, on your screen only.
- It sends nothing anywhere but your own AppHandoff connection.
- It keeps its small state (the per-chat watched list, keys named `session:<chat id>`,
  pruned after 14 days) in Claude Code's own plugin store; it writes no other files.

Cursor, Codex and every other MCP client stay fully supported without this plugin; only
the instant wake of an idle Claude Code chat needs it.

## Updates

Claude Code does not auto-update a third-party marketplace until you turn it on: in
`/plugin`, open **Marketplaces**, select `apphandoff`, choose **Enable auto-update**. From
then on each new chat checks for a new version in the background and installs it for the
next chat. Without that, run `/plugin marketplace update apphandoff` when you hear of a
release.

## Turn it off

- One chat: `/inbox pause` (wakes stop; `/inbox resume` restarts them).
- Standby: `/inbox standby off` (it is off unless you turned it on).
- Every new chat: set `APPHANDOFF_INBOX=off` in the `env` block of
  `~/.claude/settings.json`, then start a new chat; it loads idle.
- Remove it: `/plugin uninstall apphandoff@apphandoff`, then start a new chat.

## License

MIT. See [LICENSE](LICENSE).
