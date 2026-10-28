// The plugin's status line is the inbox's part only. Pure: no `$` (the engine
// refuses a `$` handed across an import), so a caller shows the result itself:
//   $.ui.status(statusWith('inbox', text))

export type StatusPart = 'inbox'

const parts: Record<StatusPart, string | undefined> = { inbox: undefined }

/** The parts that have text; undefined when none does (the line clears). */
export function joinStatus(all: Readonly<Record<StatusPart, string | undefined>>): string | undefined {
  const text = [all.inbox].filter((p): p is string => typeof p === 'string' && p !== '')
  return text.length > 0 ? text.join(' | ') : undefined
}

/** Set one add-on's part and return the whole line to show. */
export function statusWith(part: StatusPart, text: string | undefined): string | undefined {
  parts[part] = text
  return joinStatus(parts)
}
