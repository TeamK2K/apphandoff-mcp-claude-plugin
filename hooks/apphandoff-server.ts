// Which MCP server is AppHandoff (HO-17543). The ONE recognition both add-ons
// use — the inbox (inbox-core.ts) and the touched panes (touched-core.ts) — so
// they never disagree about whose call a transcript row is. Pure: no `$`, no I/O.
//
// A tool arrives as `mcp__<server>__<tool>`. The host names the server one of
// two ways: after the connector (`mcp__apphandoff__get`), or by an id (the
// Claude desktop app: `mcp__74eab0da-aeae-4938-857d-818f76b8f0bc__get`). The
// ten tool names are generic words, so on their own they prove nothing:
//   - a server named like AppHandoff is AppHandoff by its tool names alone;
//   - an id-named server is AppHandoff only once an answer carries text only
//     AppHandoff writes (answerNamesAppHandoff);
//   - any other server is never AppHandoff.

/**
 * The tool names the AppHandoff server registers. Pinned equal to the served
 * catalogue by tests/inbox-core.spec.ts.
 */
export const DETECTOR_TOOLS = [
  'bootstrap',
  'get',
  'find',
  'read_skill',
  'ticket',
  'plan',
  'message',
  'project',
  'question',
  'decide_lifecycle_proposal',
] as const
const APPHANDOFF_TOOLS = new Set<string>(DETECTOR_TOOLS)

/** `mcp__<server>__<tool>`; the server is the first segment, never a router's. */
export function parseToolName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m?.[1] && m[2] ? { server: m[1], tool: m[2] } : null
}

/** Whether `mcp__<server>__<tool>` is an AppHandoff tool by name alone: one of the ten, on a server named like it. */
export function isAppHandoffTool(server: string, tool: string): boolean {
  return APPHANDOFF_TOOLS.has(tool) && /apphandoff/i.test(server)
}

const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A server the host named by an id rather than by the connector's name. */
export const isIdNamedServer = (server: string): boolean => SERVER_ID.test(server)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

const PORTAL_ORIGIN = 'https://portal.apphandoff.com/'
/** A write rule id: `ticket.`, `plan.`, `message.` or `project.` then the rule. */
const RULE_ID = /^(?:ticket|plan|message|project)\./

/**
 * Whether an answer is one only AppHandoff writes, read from its STRUCTURE —
 * the whole answer parsed as JSON, never a search through its text, so a
 * foreign answer that merely quotes a portal link or a field name proves
 * nothing. One of: a top-level `guidance_rev` string; `project.resolved_by`; a
 * `rule_id` (top level, or in a `refusal`) beginning `ticket.`/`plan.`/
 * `message.`/`project.`; a `url` or `portal_url` (top level, or in its `card`
 * or `refusal`) beginning with the portal origin.
 */
export function answerNamesAppHandoff(answer: string | undefined): boolean {
  if (typeof answer !== 'string') return false
  let json: unknown
  try {
    json = JSON.parse(answer.trim())
  } catch {
    return false
  }
  if (!isRecord(json)) return false
  if (text(json.guidance_rev)) return true
  if (isRecord(json.project) && text(json.project.resolved_by)) return true
  const holders = [json, json.refusal, json.card].filter(isRecord)
  for (const h of holders) {
    const rule = text(h.rule_id)
    if (rule && RULE_ID.test(rule)) return true
    for (const url of [text(h.url), text(h.portal_url)]) if (url?.startsWith(PORTAL_ORIGIN)) return true
  }
  return false
}

/**
 * Whether a call may turn out to be AppHandoff's, before its answer is in: an
 * AppHandoff-named server's tool, or one of the ten tools on an id-named
 * server. Such a call is held until its answer says whose it is.
 */
export function mayBeAppHandoff(server: string, tool: string): boolean {
  return isAppHandoffTool(server, tool) || (APPHANDOFF_TOOLS.has(tool) && isIdNamedServer(server))
}

/**
 * Whether a finished call is AppHandoff's: by the server's name, or by an
 * id-named server's answer — never one that is an error (a refusal proves
 * little about who wrote it).
 */
export function isAppHandoffCall(server: string, tool: string, answer: string | undefined, isError = false): boolean {
  if (isAppHandoffTool(server, tool)) return true
  return !isError && mayBeAppHandoff(server, tool) && answerNamesAppHandoff(answer)
}
