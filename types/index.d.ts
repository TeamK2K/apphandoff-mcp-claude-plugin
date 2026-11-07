// The plugin's contract for `$.state` (HO-22951): the ticket titles a reply is drawn with.
// Lives in `types/` (the engine's layout for a state contract), named in plugin.json as `types`, so the
// plugin directory does not read it as code the mod could load (HO-24959).

/** `HO-12` to the shortened title the drawing puts beside it; written by the lookup, read by the drawing. */
export type ApphandoffTitles = Record<string, string>;

declare module 'claude-code' {
  interface PluginState {
    apphandoff: { ticketTitles: ApphandoffTitles };
  }
}
