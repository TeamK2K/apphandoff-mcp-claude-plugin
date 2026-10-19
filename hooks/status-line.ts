// The plugin has ONE status line, and two add-ons write to it (the inbox, the
// touched panes). Each owns a part; the line is the parts that have text,
// side by side, so neither overwrites the other. Pure: no `$` (the engine
// refuses a `$` handed across an import), so a caller shows the result itself:
//   $.ui.status(statusWith('touched', text))

export type StatusPart = 'inbox' | 'touched'

const parts: Record<StatusPart, string | undefined> = { inbox: undefined, touched: undefined }

/** The parts that have text, in a fixed order; undefined when none does (the line clears). */
export function joinStatus(all: Readonly<Record<StatusPart, string | undefined>>): string | undefined {
  const text = [all.inbox, all.touched].filter((p): p is string => typeof p === 'string' && p !== '')
  return text.length > 0 ? text.join(' | ') : undefined
}

/** Set one add-on's part and return the whole line to show. */
export function statusWith(part: StatusPart, text: string | undefined): string | undefined {
  parts[part] = text
  return joinStatus(parts)
}
