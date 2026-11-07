import type { ClientModule, RenderChildren } from 'claude-code'

// The /pg program view's drawing (HO-24860), a surface module: one total bar, the milestones still
// moving as a table whose milestone number opens its tickets, the finished ones folded. It only draws:
// ./register.tsx works the numbers out (./program-view.ts) and hands them over as props. It asks the
// hooks module to re-read the board every minute, which runs only while this drawing is on screen.
type Row = { ref: string; title: string; status: string; percent: number | null; approval: boolean }
type Props = {
  ref: string
  name: string
  headline?: string
  percent: number
  shipped: number
  total: number
  bar: { shipped: number; active: number }
  inFlight: Row[]
  finished: Row[]
  updatedAt: number
  refreshing: boolean
}
type State = { showFinished: boolean; now: number }

const DOT: Record<string, string> = {
  building: 'yellow',
  approved: 'cyan',
  draft: 'gray',
  done: 'green',
  dropped: 'red',
}
const SHIPPED = 'green'
const MOVING = 'yellow'
const QUEUED = 'gray'
const NEEDS_YOU = 'magenta'
const REFRESH_MS = 60_000

// The same as ago() in ./program-view.ts (a client module imports nothing); tests/program-view.spec.ts pins them equal.
const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 10 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}

const PgClient: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ showFinished: false, now: Date.now() })
    surface.every(5_000, () => surface.setState({ ...(surface.state ?? { showFinished: false }), now: Date.now() }))
    surface.every(REFRESH_MS, () => surface.post({ refresh: props.ref }))
  }
  const showFinished = surface.state?.showFinished ?? false
  const now = surface.state?.now ?? Date.now()

  // A bar of coloured segments; each segment a painted Box with a whole-percent width, so it fills the
  // width it is given on any surface instead of counting glyphs.
  const bar = (parts: Array<[number, string]>) => (
    <Box flexDirection="row" width="100%" backgroundColor={QUEUED}>
      {parts
        .filter(([n]) => n > 0)
        .map(([n, color]) => (
          <Box width={`${n}%`} backgroundColor={color}>
            <Text> </Text>
          </Box>
        ))}
      <Box flexGrow={1}>
        <Text> </Text>
      </Box>
    </Box>
  )

  // One table row: four cells side by side. No fragments: a surface may stack
  // a fragment's children instead of laying them into the row.
  const line = (
    key: string | undefined,
    ref: RenderChildren,
    title: RenderChildren,
    status: RenderChildren,
    progress: RenderChildren,
  ) => (
    <Box key={key} flexDirection="row" width="100%" paddingX={1} hover={key ? { backgroundColor: 'gray' } : undefined}>
      <Box width="4%" minWidth={2} flexShrink={0}>
        {status}
      </Box>
      <Box width="14%" flexShrink={0}>
        {ref}
      </Box>
      <Box width="68%" flexShrink={0} overflow="hidden" flexDirection="row" columnGap={1} paddingRight={1}>
        {title}
      </Box>
      <Box width="14%" flexShrink={0} justifyContent="flex-end">
        {progress}
      </Box>
    </Box>
  )

  const row = (m: Row, quiet: boolean) => {
    const flags = m.approval ? '⚑ approve' : ''
    return line(
      `row-${m.ref}`,
      <Button key={`open-${m.ref}`} plain onPress={() => surface.post({ open: m.ref })}>
        {m.ref}
      </Button>,
      [
        <Box flexShrink={1} flexGrow={1} overflow="hidden">
          <Text wrap="truncate-end" dimColor={quiet}>
            {m.title}
          </Text>
        </Box>,
        flags ? (
          <Box flexShrink={0}>
            <Text color={NEEDS_YOU}>{flags}</Text>
          </Box>
        ) : null,
      ],
      <Text color={DOT[m.status]} dimColor={quiet}>
        ●
      </Text>,
      <Text dimColor={quiet || !m.percent}>{m.percent === null ? '–' : `${m.percent}%`}</Text>,
    )
  }

  const head = () =>
    line(
      undefined,
      <Text dimColor>#</Text>,
      <Text dimColor>Milestone</Text>,
      <Text> </Text>,
      <Text dimColor>Progress</Text>,
    )

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Box flexDirection="column" flexShrink={1}>
          <Text bold>
            {props.ref} · {props.name}
          </Text>
          {props.headline && <Text dimColor>{props.headline}</Text>}
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{props.refreshing ? 'refreshing…' : `updated ${ago(now - props.updatedAt)}`}</Text>
        </Box>
      </Box>

      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text bold>{props.percent}%</Text> shipped
          </Text>
          <Text dimColor>
            {props.shipped} of {props.total} tickets
          </Text>
        </Box>
        {bar([
          [props.bar.shipped, SHIPPED],
          [props.bar.active, MOVING],
        ])}
      </Box>

      <Box flexDirection="column">
        <Text bold>In flight · {props.inFlight.length}</Text>
        <Box flexDirection="column">
          {head()}
          {props.inFlight.length ? (
            props.inFlight.map((m) => row(m, false))
          ) : (
            <Box paddingX={1}>
              <Text dimColor>Nothing in flight.</Text>
            </Box>
          )}
        </Box>
      </Box>

      {props.finished.length > 0 && (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Button key="toggle-finished" plain onPress={() => surface.setState({ now, showFinished: !showFinished })}>
              {showFinished ? '▾' : '▸'} Finished · {props.finished.length}
            </Button>
          </Box>
          {showFinished && (
            <Box flexDirection="column">
              {head()}
              {props.finished.map((m) => row(m, true))}
            </Box>
          )}
        </Box>
      )}
      <Text dimColor>Click a milestone number to see its tickets.</Text>
    </Box>
  )
}

export default PgClient
