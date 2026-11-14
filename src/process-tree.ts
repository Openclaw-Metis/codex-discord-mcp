import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

// Cancelling an agent CLI run must also stop the tool commands it started.
// The CLI is spawned as a process-group leader on POSIX, but agents usually
// launch tool commands in their own session (setsid), out of reach of a group
// signal; once the CLI dies those are reparented to init and keep running.
// So the descendants are collected from the process table while the CLI is
// still alive, and signalled individually as well.

export const USE_PROCESS_GROUP = process.platform !== 'win32'

type Signalable = { pid?: number; kill: (signal: NodeJS.Signals) => boolean }

// pid -> parent pid for every visible process. Linux reads /proc; other POSIX
// systems fall back to `ps`. Windows (and any failure) yields an empty table.
export function readProcessTable(): Map<number, number> {
  const table = new Map<number, number>()
  if (process.platform === 'win32') return table

  if (process.platform === 'linux') {
    let entries: string[] = []
    try {
      entries = readdirSync('/proc')
    } catch {}
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
        // Format: "pid (comm) state ppid ..."; comm may contain spaces/parens.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        const ppid = Number.parseInt(fields[1] ?? '', 10)
        if (Number.isFinite(ppid)) table.set(Number(entry), ppid)
      } catch {
        // process exited while scanning
      }
    }
    if (table.size > 0) return table
  }

  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 })
  for (const line of (ps.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match) table.set(Number(match[1]), Number(match[2]))
  }
  return table
}

// All descendants of the given roots (excluding the roots themselves).
export function descendantPids(
  roots: number[],
  table: Map<number, number> = readProcessTable(),
): number[] {
  const children = new Map<number, number[]>()
  for (const [pid, ppid] of table) {
    const list = children.get(ppid)
    if (list) list.push(pid)
    else children.set(ppid, [pid])
  }

  const seen = new Set<number>(roots)
  const out: number[] = []
  const queue = [...roots]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      out.push(child)
      queue.push(child)
    }
  }
  return out
}

// Signal the child's process group (POSIX) or the child itself.
export function signalProcessGroup(child: Signalable, signal: NodeJS.Signals): void {
  if (USE_PROCESS_GROUP && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // group already gone, or not a group leader: fall back to the child
    }
  }
  try {
    child.kill(signal)
  } catch {}
}

// SIGTERM the child, its process group, and every descendant found now; after
// graceMs, SIGKILL the same set plus anything they spawned meanwhile. Returns
// the (unref'd) SIGKILL timer.
export function terminateProcessTree(child: Signalable, graceMs: number): NodeJS.Timeout {
  const known = child.pid && USE_PROCESS_GROUP ? descendantPids([child.pid]) : []

  const signalAll = (signal: NodeJS.Signals, pids: number[]): void => {
    signalProcessGroup(child, signal)
    for (const pid of pids) {
      try {
        process.kill(pid, signal)
      } catch {}
    }
  }

  signalAll('SIGTERM', known)
  const timer = setTimeout(() => {
    const roots = child.pid ? [child.pid, ...known] : known
    const latest = USE_PROCESS_GROUP ? descendantPids(roots) : []
    signalAll('SIGKILL', [...new Set([...known, ...latest])])
  }, graceMs)
  timer.unref()
  return timer
}
