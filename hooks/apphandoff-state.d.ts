// The plugin's contract for `$.state` (HO-22951): the ticket titles a reply is drawn with.
// Shipped beside the hooks (the marketplace zip carries `hooks/*.ts`), named in plugin.json as `types`.

/** `HO-12` to the shortened title the drawing puts beside it; written by the lookup, read by the drawing. */
export type ApphandoffTitles = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    apphandoff: { ticketTitles: ApphandoffTitles }
  }
}
