export type Day = {
  turns: number
  seconds: number
  added: number
  removed: number
  errors: number
  hours: number[]
  tools: Record<string, number>
  files: Record<string, number>
}

export const emptyDay = (): Day => ({ turns: 0, seconds: 0, added: 0, removed: 0, errors: 0, hours: Array(24).fill(0), tools: {}, files: {} })

const pad = (n: number) => String(n).padStart(2, '0')
export const dateKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const bump = (record: Record<string, number>, key: string, by = 1) => ({ ...record, [key]: (record[key] ?? 0) + by })

export function mergeDay(day: Day, delta: Day): Day {
  let tools = day.tools
  for (const [k, v] of Object.entries(delta.tools)) tools = bump(tools, k, v)
  let files = day.files
  for (const [k, v] of Object.entries(delta.files)) files = bump(files, k, v)
  // ponytail: per-day file map capped at 300 keys; busiest files win.
  files = Object.fromEntries(Object.entries(files).sort((a, b) => b[1] - a[1]).slice(0, 300))
  return {
    turns: day.turns + delta.turns,
    seconds: day.seconds + delta.seconds,
    added: day.added + delta.added,
    removed: day.removed + delta.removed,
    errors: day.errors + delta.errors,
    hours: day.hours.map((h, i) => h + (delta.hours[i] ?? 0)),
    tools,
    files,
  }
}

// Consecutive days with at least one turn, ending today or yesterday.
export function streak(activeDates: ReadonlySet<string>, now: number): number {
  let ms = activeDates.has(dateKey(now)) ? now : now - 86_400_000
  let count = 0
  while (activeDates.has(dateKey(ms))) {
    count += 1
    ms -= 86_400_000
  }
  return count
}

export type Facts = { today: Day; turnSeconds: number; at: number; totalTurns: number; streak: number }

export const ACHIEVEMENTS: { id: string; title: string; desc: string; test: (f: Facts) => boolean }[] = [
  { id: 'hello', title: 'Hello, Claude', desc: 'Finished your first turn', test: f => f.totalTurns >= 1 },
  { id: 'night-owl', title: 'Night Owl', desc: 'Coded between midnight and 5am', test: f => new Date(f.at).getHours() < 5 },
  { id: 'early-bird', title: 'Early Bird', desc: 'Coded between 5 and 7am', test: f => [5, 6].includes(new Date(f.at).getHours()) },
  { id: 'weekend', title: 'Weekend Warrior', desc: 'Coded on a Saturday or Sunday', test: f => [0, 6].includes(new Date(f.at).getDay()) },
  { id: 'marathon', title: 'Marathon', desc: 'One turn ran 10+ minutes', test: f => f.turnSeconds >= 600 },
  { id: 'centurion', title: 'Centurion', desc: '100 turns together', test: f => f.totalTurns >= 100 },
  { id: 'pair-for-life', title: 'Pair for Life', desc: '1,000 turns together', test: f => f.totalTurns >= 1000 },
  { id: 'big-bang', title: 'Big Bang', desc: 'Added 1,000+ lines in a day', test: f => f.today.added >= 1000 },
  { id: 'kondo', title: 'Marie Kondo', desc: 'Deleted 300+ lines in a day, more than you added', test: f => f.today.removed >= 300 && f.today.removed > f.today.added },
  { id: 'on-fire', title: 'On Fire', desc: 'A 7-day streak', test: f => f.streak >= 7 },
  { id: 'unstoppable', title: 'Unstoppable', desc: 'A 30-day streak', test: f => f.streak >= 30 },
  { id: 'error-collector', title: 'Error Collector', desc: '10 failed tool calls in a day', test: f => f.today.errors >= 10 },
  { id: 'shell-wizard', title: 'Shell Wizard', desc: '50 shell commands in a day', test: f => (f.today.tools.Bash ?? 0) >= 50 },
  { id: 'polyglot', title: 'Polyglot', desc: 'Touched 5 file types in a day', test: f => new Set(Object.keys(f.today.files).map(p => p.split('.').pop())).size >= 5 },
]

export function newlyUnlocked(facts: Facts, unlocked: Readonly<Record<string, number>>) {
  return ACHIEVEMENTS.filter(a => !(a.id in unlocked) && a.test(facts))
}

export type Summary = {
  turns: number
  hours: number
  added: number
  removed: number
  files: number
  errors: number
  topFiles: [string, number][]
  topTools: [string, number][]
  busiest: [string, number] | undefined
  peakHour: number
  nightShare: number
  personality: string
}

export function summarize(days: Readonly<Record<string, Day>>): Summary {
  const all = Object.values(days).reduce(mergeDay, emptyDay())
  const top = (record: Record<string, number>) => Object.entries(record).sort((a, b) => b[1] - a[1]).slice(0, 5)
  const nightTurns = [22, 23, 0, 1, 2, 3, 4].reduce((sum, h) => sum + all.hours[h]!, 0)
  const nightShare = all.turns ? nightTurns / all.turns : 0
  const topTool = top(all.tools)[0]?.[0]
  const busiest = Object.entries(days).sort((a, b) => b[1].turns - a[1].turns)[0]
  const personality =
    nightShare >= 0.4 ? 'The Night Owl 🦉'
    : all.removed > all.added && all.removed > 200 ? 'The Refactorer 🧹'
    : topTool === 'Bash' ? 'The Shell Wizard 🧙'
    : ['Read', 'Grep', 'Glob'].includes(topTool ?? '') ? 'The Detective 🔎'
    : all.added > 2000 ? 'The Builder 🏗️'
    : all.turns && all.errors / all.turns > 1 ? 'The Daredevil 🔥'
    : 'The Steady Shipper 🚢'
  return {
    turns: all.turns,
    hours: Math.round((all.seconds / 3600) * 10) / 10,
    added: all.added,
    removed: all.removed,
    files: Object.keys(all.files).length,
    errors: all.errors,
    topFiles: top(all.files),
    topTools: top(all.tools),
    busiest: busiest && [busiest[0], busiest[1].turns],
    peakHour: all.hours.indexOf(Math.max(...all.hours)),
    nightShare,
    personality,
  }
}

// GitHub-style: one column per week (Sunday first), weeks ending with this one.
export function heatmap(days: Readonly<Record<string, Day>>, now: number, weeks: number): { date: string; turns: number; level: number; isFuture: boolean }[][] {
  const today = new Date(now)
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay() - (weeks - 1) * 7)
  const max = Math.max(1, ...Object.values(days).map(d => d.turns))
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const at = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d).getTime()
      const date = dateKey(at)
      const turns = days[date]?.turns ?? 0
      return { date, turns, level: turns === 0 ? 0 : Math.ceil((turns / max) * 4), isFuture: at > now }
    }),
  )
}
