// AppHandoff for Claude Code — a time limit for the plugin's board calls (HO-21343).
//
// Pure and used by ./register.ts: no `$.mcp.call` the plugin
// makes may wait for ever, or one call that never settles (a dropped connection)
// leaves the inbox's `polling` flag set and every later poll returns at once. The
// server answers its own 45 s TIMEOUT first when it can; this is the backstop, so
// the plugin does not depend on the engine cutting a call off. The timer is the
// engine's clock, handed in as a function (each call site spells `$.clock.after`
// itself: the engine refuses a bare `$.clock` passed around), so the specs drive it.

/** How long a board call may take before the plugin gives up on it. */
export const CALL_TIMEOUT_MS = 60_000

/** The one timer this needs: the engine clock's `after`, called as `(ms, fn) => $.clock.after(ms, fn)`. */
export type After = (ms: number, fn: () => void) => { cancel: () => void }

const TIMEOUT_TEXT = 'AppHandoff call timed out after'

/**
 * The failure a call past the limit settles as. Its text names the timeout and
 * holds nothing the inbox reads as a sign-in failure or a rate limit (see
 * inbox-core's isAuthError and retryAfterMs), so it is an ordinary failed call.
 */
export class CallTimeoutError extends Error {
  constructor(ms: number) {
    super(`${TIMEOUT_TEXT} ${Math.round(ms / 1000)} s`)
    this.name = 'CallTimeoutError'
  }
}

/** Whether a failure's text is this plugin's own timeout (not the server's TIMEOUT answer): a dead link, so the tick ends. */
export const isTimeout = (text: string): boolean => text.includes(TIMEOUT_TEXT)

/**
 * Race a board call against the limit: the answer passes through unchanged when it
 * comes first, a rejection passes through as it is, and no answer by the limit
 * rejects with a CallTimeoutError. Whatever settles second is dropped, so an
 * answer that arrives late changes no state.
 */
export function withCallTimeout<T>(after: After, call: Promise<T>, ms = CALL_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    let timer: { cancel: () => void } | null = null
    const settle = (finish: () => void) => {
      if (done) return
      done = true
      timer?.cancel()
      finish()
    }
    // Attached first and always: a call that fails after the limit must not go unhandled.
    call.then(
      (answer) => settle(() => resolve(answer)),
      (err) => settle(() => reject(err)),
    )
    timer = after(ms, () => settle(() => reject(new CallTimeoutError(ms))))
  })
}
