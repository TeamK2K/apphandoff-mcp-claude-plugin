// The plugin's contract for `$.state` (HO-22951): the ticket titles a reply is drawn with, and what the ticket views draw from.
// Lives in `types/` (the engine's layout for a state contract), named in plugin.json as `types`, so the
// plugin directory does not read it as code the mod could load (HO-24959).

/** `HO-12` to the shortened title the drawing puts beside it; written by the lookup, read by the drawing. */
export type ApphandoffTitles = Record<string, string>;

/** `HO-12` to its hover card (full title, stage, status, claim; lines joined with `\n`), drawn as the link's tooltip. */
export type ApphandoffHovers = Record<string, string>;

/** A milestone or program a card sits under. */
export type ApphandoffParent = { ref: string; name: string };

/** What one board card said, kept as data: the ticket views (band, shelf, hint, tool rows, stage in links) draw from it. */
export type ApphandoffInfo = {
  kind: 'ticket' | 'milestone' | 'program';
  title: string;
  stage?: string;
  status?: string;
  state?: string;
  priority?: string;
  size?: string;
  claims?: string[];
  milestone?: ApphandoffParent;
  program?: ApphandoffParent;
  counts?: Record<string, number>;
  readAt: number;
};

/** `HO-12`, `MS-3` or `PG-1` to its card. */
export type ApphandoffInfos = Record<string, ApphandoffInfo>;

/** The ids this chat named latest first, its watched tickets, and the lease each of them holds until (ms). */
export type ApphandoffFocus = { recent: string[]; watched: string[]; held: Record<string, number> };

/** Which ticket views are on, by option name (`/hoview`). */
export type ApphandoffOptions = Record<string, boolean>;

declare module 'claude-code' {
  interface PluginState {
    apphandoff: {
      ticketTitles: ApphandoffTitles;
      ticketHovers: ApphandoffHovers;
      ticketInfo: ApphandoffInfos;
      ticketFocus: ApphandoffFocus;
      hoviewOptions: ApphandoffOptions;
    };
  }
}
