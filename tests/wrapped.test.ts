import { expect, mock, test } from 'claude-code/testing'

import { shareText } from '../hooks/register'
import { dateKey, emptyDay, heatmap, mergeDay, newlyUnlocked, streak, summarize } from '../hooks/stats'

const DAY = 86_400_000
const now = new Date(2026, 9, 9, 23, 30).getTime() // a Friday night

test('merges days and summarizes a personality', () => {
  const night = { ...emptyDay(), turns: 5, added: 50, hours: emptyDay().hours.map((_, h) => (h === 23 ? 5 : 0)), tools: { Bash: 9, Edit: 3 }, files: { 'a.ts': 3 } }
  const merged = mergeDay(night, { ...emptyDay(), turns: 1, files: { 'a.ts': 1, 'b.py': 1 } })
  expect(merged.turns).toBe(6)
  expect(merged.files).toEqual({ 'a.ts': 4, 'b.py': 1 })
  const s = summarize({ [dateKey(now)]: night })
  expect(s.personality).toBe('The Night Owl 🦉')
  expect(s.topTools[0]).toEqual(['Bash', 9])
  expect(s.busiest).toEqual([dateKey(now), 5])
  expect(shareText(s, 12, 3)).toContain("I'm The Night Owl 🦉")
})

test('streaks count back from today or yesterday', () => {
  const dates = new Set([0, 1, 2, 4].map(back => dateKey(now - back * DAY)))
  expect(streak(dates, now)).toBe(3)
  expect(streak(new Set([dateKey(now - DAY)]), now)).toBe(1)
  expect(streak(new Set(), now)).toBe(0)
})

test('achievements unlock once', () => {
  const facts = { today: { ...emptyDay(), turns: 1 }, turnSeconds: 700, at: new Date(2026, 9, 10, 2).getTime(), totalTurns: 1, streak: 1 }
  const ids = newlyUnlocked(facts, {}).map(a => a.id)
  expect(ids).toEqual(['hello', 'night-owl', 'weekend', 'marathon'])
  expect(newlyUnlocked(facts, Object.fromEntries(ids.map(id => [id, 1])))).toHaveLength(0)
})

test('heatmap is weeks x 7 with future days marked', () => {
  const grid = heatmap({ [dateKey(now)]: { ...emptyDay(), turns: 4 } }, now, 12)
  expect(grid).toHaveLength(12)
  expect(grid[11]![5]).toMatchObject({ date: dateKey(now), turns: 4, level: 4, isFuture: false })
  expect(grid[11]![6]!.isFuture).toBe(true)
})

test('a turn unlocks an achievement and the pane draws on both surfaces', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  await clock.set(now)
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? JSON.stringify(e)))
    return { value: undefined }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await $.turn.complete({ answer: 'ok', durationMs: 30_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(toasts.join('\n')).toContain('Hello, Claude')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'code-wrapped', surface, component: 'Pane', requestId: 'wrapped', props: { bodyColumns: 60 } as never })
    expect(await ui.find({ key: 'copy' })).toBeDefined()
    expect(JSON.stringify(await ui.drawn())).toContain(surface === 'terminal' ? '"type":"Raster"' : '"type":"Svg"')
  }
})
