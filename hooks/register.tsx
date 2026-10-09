import type { EngineInterface, Register } from 'claude-code'

import { ACHIEVEMENTS, bump, dateKey, emptyDay, heatmap, mergeDay, newlyUnlocked, streak, summarize } from './stats'
import type { Day, Summary } from './stats'

const PANE = 'wrapped'
const DAY_MS = 86_400_000
const LEVELS = [0x2d333b, 0x0e4429, 0x006d32, 0x26a641, 0x39d353]
const lineCount = (text: string) => (text === '' ? 0 : text.split('\n').length)

let pending: Day = emptyDay()
let weeksAsked: number | undefined

async function loadDays($: EngineInterface, sinceMs: number): Promise<Record<string, Day>> {
  const since = `day:${dateKey(sinceMs)}`
  const days: Record<string, Day> = {}
  for (const key of await $.store.keys()) {
    if (key.startsWith('day:') && key >= since) days[key.slice(4)] = (await $.store.get(key)) as Day
  }
  return days
}

export function shareText(s: Summary, weeks: number, streakDays: number): string {
  return `My Claude Code Wrapped (last ${weeks} weeks): ${s.turns} turns, ${s.hours}h, +${s.added.toLocaleString('en-US')}/−${s.removed.toLocaleString('en-US')} lines across ${s.files} files, ${streakDays}-day streak. I'm ${s.personality}. Get yours: github.com/lakmadev/claude-mods`
}

// Cells for the terminal Raster: one ■ per day plus a gap, weekday rows, week columns.
function heatCells(grid: ReturnType<typeof heatmap>): string {
  const columns = grid.length * 2
  const view = new DataView(new ArrayBuffer(columns * 7 * 12))
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < columns; col++) {
      const cell = grid[Math.floor(col / 2)]![row]!
      const isGap = col % 2 === 1 || cell.isFuture
      const at = (row * columns + col) * 12
      view.setUint32(at, isGap ? 0x20 : 0x25a0, true)
      view.setUint32(at + 4, isGap ? 0x01000000 : LEVELS[cell.level]!, true)
      view.setUint32(at + 8, 0x01000000, true)
    }
  }
  return toBase64(new Uint8Array(view.buffer))
}

function heatSvg(grid: ReturnType<typeof heatmap>): string {
  const step = 14
  const rects = grid.flatMap((week, w) =>
    week.filter(d => !d.isFuture).map((d, row) =>
      `<rect x="${w * step}" y="${row * step}" width="11" height="11" rx="2" fill="#${LEVELS[d.level]!.toString(16).padStart(6, '0')}"><title>${d.date}: ${d.turns} turns</title></rect>`,
    ),
  )
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${grid.length * step}" height="${7 * step}">${rects.join('')}</svg>`
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

const bar = (value: number, max: number, width = 16) => '█'.repeat(Math.max(1, Math.round((value / Math.max(1, max)) * width)))
const shortPath = (path: string) => (path.length > 40 ? `…${path.slice(-39)}` : path)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'wrapped', description: 'Your Claude Code Wrapped: heatmap, stats, achievements', argumentHint: '[weeks]' })
    const cutoff = `day:${dateKey((await $.clock.now()) - 400 * DAY_MS)}`
    for (const key of await $.store.keys()) if (key.startsWith('day:') && key < cutoff) await $.store.delete(key)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    pending.tools = bump(pending.tools, String(e.tool))
    if (ran.isError) pending.errors += 1
    else if (e.tool === 'Edit') {
      pending.added += lineCount(e.new_string)
      pending.removed += lineCount(e.old_string)
      pending.files = bump(pending.files, e.file_path)
    } else if (e.tool === 'Write') {
      pending.added += lineCount(e.content)
      pending.files = bump(pending.files, e.file_path)
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const now = await $.clock.now()
    const delta = { ...pending, turns: 1, seconds: Math.round(e.durationMs / 1000), hours: pending.hours.map((h, i) => (i === new Date(now).getHours() ? h + 1 : h)) }
    pending = emptyDay()

    const key = `day:${dateKey(now)}`
    const today = mergeDay(((await $.store.get(key)) as Day | undefined) ?? emptyDay(), delta)
    await $.store.set(key, today)
    const totalTurns = (((await $.store.get('totalTurns')) as number | undefined) ?? 0) + 1
    await $.store.set('totalTurns', totalTurns)

    const active = new Set((await $.store.keys()).filter(k => k.startsWith('day:')).map(k => k.slice(4)))
    const unlocked = ((await $.store.get('achievements')) as Record<string, number> | undefined) ?? {}
    const fresh = newlyUnlocked({ today, turnSeconds: delta.seconds, at: now, totalTurns, streak: streak(active, now) }, unlocked)
    if (fresh.length) {
      await $.store.set('achievements', { ...unlocked, ...Object.fromEntries(fresh.map(a => [a.id, now])) })
      for (const a of fresh) $.ui.toast(`🏆 Achievement unlocked: ${a.title}. ${a.desc}. (/wrapped)`, { timeoutMs: 6000 })
    }
    return done
  })

  on('command.run', { command: 'wrapped' }, async ($, e) => {
    const weeks = Number.parseInt(e.args, 10)
    weeksAsked = weeks > 0 ? Math.min(weeks, 52) : undefined
    await $.ui.open({ id: PANE, title: '✨ Your Claude Code Wrapped' })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const now = await $.clock.now()
    const fit = Math.floor(((e.props.bodyColumns ?? 60) - 2) / 2)
    const weeks = weeksAsked ?? Math.max(4, Math.min(26, 'Raster' in elements ? fit : 26))
    const days = await loadDays($, now - weeks * 7 * DAY_MS)
    const s = summarize(days)
    const active = new Set((await $.store.keys()).filter(k => k.startsWith('day:')).map(k => k.slice(4)))
    const streakDays = streak(active, now)
    const unlocked = ((await $.store.get('achievements')) as Record<string, number> | undefined) ?? {}
    const grid = heatmap(days, now, weeks)

    if (s.turns === 0) return <Text dimColor>No turns recorded yet. Finish a few turns with Claude, then run /wrapped again.</Text>

    const maxFile = s.topFiles[0]?.[1] ?? 1
    const maxTool = s.topTools[0]?.[1] ?? 1
    const heat =
      'Raster' in elements ? <elements.Raster key="heat" columns={weeks * 2} rows={7} cells={heatCells(grid)} />
      : 'Svg' in elements ? <elements.Svg source={heatSvg(grid)} alt={`Activity heatmap, ${s.turns} turns over ${weeks} weeks`} isInteractive />
      : <Text dimColor>{s.turns} turns over {weeks} weeks</Text>

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text dimColor>Your coding personality</Text>
          <Text bold color="claude">{s.personality}</Text>
        </Box>
        {heat}
        <Box flexDirection="column">
          <Text>
            <Text bold>{s.turns}</Text> turns · <Text bold>{s.hours}h</Text> with Claude · <Text color="diffAdded">+{s.added}</Text> <Text color="diffRemoved">−{s.removed}</Text> lines · <Text bold>{s.files}</Text> files
          </Text>
          <Text dimColor>
            🔥 {streakDays}-day streak{s.busiest ? ` · busiest day ${s.busiest[0]} (${s.busiest[1]} turns)` : ''} · peak hour {String(s.peakHour).padStart(2, '0')}:00
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text bold>Top files</Text>
          {s.topFiles.map(([path, n]) => (
            <Text>
              <Text color="success">{bar(n, maxFile)}</Text> {n} {shortPath(path)}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>Favourite tools</Text>
          {s.topTools.map(([tool, n]) => (
            <Text>
              <Text color="suggestion">{bar(n, maxTool)}</Text> {n} {tool}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>Achievements {Object.keys(unlocked).length}/{ACHIEVEMENTS.length}</Text>
          {ACHIEVEMENTS.map(a =>
            a.id in unlocked ? <Text>🏆 {a.title} <Text dimColor>· {a.desc}</Text></Text> : <Text dimColor>🔒 {a.title}</Text>,
          )}
        </Box>
        <Button key="copy" label="Copy share text" variant="primary" onPress={() => $.ui.copy({ text: shareText(s, weeks, streakDays), surface: e.surface })} />
      </Box>
    )
  })
}
