// The touched panes' types, and the state they declare to the engine: the
// manifest's `types` names this file, and the engine refuses a `$.state` read
// or write the contract does not declare. Type-only: nothing here runs.

export type Approval = {
  proposal_id: string
  /** The AppHandoff server the refused move came through: the one a decision is sent to. */
  server: string
  /** A portal link (always on the portal origin). */
  url: string
  to_status: string | null
  seen_at: number
}

export type Milestone = {
  ref: string
  title: string | null
  status: string | null
  last_at: number
  last_action: string
  approval: Approval | null
  /** From the milestone's card, once an answer carried it. */
  goal?: string
  /** Open tickets, from the card's `tickets.open`. */
  open?: number
  /** All its tickets, from the card's `tickets.total` when the card carried it: the progress bar's whole. */
  total?: number
  /** The project (id or name) the chat's call named: what the pane's reads pass. */
  project?: string
}

/** One line of an opened milestone: a ticket as `find` lists it; `updated_at` is the board's last change. */
export type ListedTicket = {
  ref: string
  title: string | null
  stage: string | null
  status: string | null
  updated_at: string | null
}

/** Another chat's latest touch of a ticket, from its saved `touched:<sessionId>` entry. */
export type OtherTouch = { last_at: number; last_action: string }

/** An opened milestone's ticket list, as the pane last read it. */
export type TicketList =
  | { status: 'loading' }
  | { status: 'ready'; tickets: ListedTicket[]; total: number }
  | { status: 'error'; message: string }

/**
 * What the Milestones pane shows open: one milestone at most, each read list,
 * the milestone listing all its tickets rather than the touched ones (`all`),
 * other chats' recent ticket touches by HO ref, and the project names a ticket
 * title's prefix may repeat, by MS ref.
 */
export type PaneView = {
  open: string | null
  lists: Record<string, TicketList>
  all: string | null
  others: Record<string, OtherTouch>
  names: Record<string, string[]>
}

export type Ticket = {
  ref: string
  title: string | null
  stage: string | null
  status: string | null
  milestone: string | null
  last_at: number
  last_action: string
}

export type Touched = { milestones: Milestone[]; tickets: Ticket[]; server: string | null }

/** One milestone approval waiting on the person, as `find {type:"proposal"}` lists it (HO-17557). */
export type PendingApproval = {
  proposal_id: string
  /** The milestone's MS-n, when the answer carried one. */
  ref: string | null
  title: string | null
  project: { id: string | null; name: string | null } | null
  from_status: string | null
  to_status: string | null
  proposed_by: string | null
  created_at: string | null
  /** The approval's portal page (always on the portal origin). */
  url: string
}

/**
 * The Milestones pane's read of every approval waiting on the person, from any
 * chat (HO-17578); this session only, never stored. `idle` not read yet,
 * `ready` the last read listed them, `learn-only` the server has no such read,
 * `needs-sign-in` the connection may not make it, `stopped` failures ended the
 * polling until Retry.
 */
export type ApprovalsFeed = {
  status: 'idle' | 'ready' | 'learn-only' | 'needs-sign-in' | 'stopped'
  items: PendingApproval[]
  /** Whether the last good read listed every pending approval (no page left). */
  complete: boolean
  /** When the last good read was sent. */
  read_at: number | null
  /** Failed reads in a row. */
  failures: number
  /** A rate limit's wait: no read before this. */
  retry_at: number | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    apphandoff: { touched: Touched; view: PaneView; approvals: ApprovalsFeed }
  }
}
