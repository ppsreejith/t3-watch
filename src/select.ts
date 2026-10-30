import { isActiveStatus } from "./format.js";
import type { ShellThread } from "./protocol.js";
import type { LocatedThread } from "./store.js";

const ts = (value: string | null | undefined): number => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Last real activity: a message or run, not bookkeeping such as being visited. */
export function activityTime(thread: ShellThread): number {
  const activity = Math.max(
    ts(thread.activityRunStartedAt),
    ts(thread.latestRunStartedAt),
    ts(thread.latestRunCompletedAt),
    ts(thread.latestUserMessageAt),
  );
  return activity || ts(thread.updatedAt) || ts(thread.createdAt);
}

export function isSubagent(thread: ShellThread): boolean {
  return thread.lineage?.relationshipToParent === "subagent";
}

/** T3 has put the thread away: settled (done), snoozed or archived. Running threads never are. */
export function isSettled(thread: LocatedThread, now = Date.now()): boolean {
  if (isActiveStatus(thread.status) || thread.pendingRuntimeRequest) return false;
  if (thread.location === "archive" || thread.archivedAt) return true;
  if (ts(thread.snoozedUntil) > now) return true;
  const settled = ts(thread.settledAt);
  return settled > 0 && settled >= ts(thread.unsettledAt);
}

export interface ListOptions {
  subagents: boolean;
  settled: boolean;
}

export function isListed(thread: LocatedThread, options: ListOptions, now = Date.now()): boolean {
  if (thread.deletedAt) return false;
  if (!options.settled && isSettled(thread, now)) return false;
  if (!options.subagents && isSubagent(thread)) return false;
  return true;
}

export function sortByActivity<T extends ShellThread>(threads: Iterable<T>): T[] {
  return [...threads].sort((a, b) => activityTime(b) - activityTime(a) || a.id.localeCompare(b.id));
}

export function listThreads(threads: Iterable<LocatedThread>, options: ListOptions): LocatedThread[] {
  const now = Date.now();
  return sortByActivity([...threads].filter((t) => isListed(t, options, now)));
}

export function pickThreads(threads: Iterable<LocatedThread>, options: ListOptions & { count?: number }): string[] {
  const listed = listThreads(threads, options);
  return (options.count === undefined ? listed : listed.slice(0, Math.max(0, options.count))).map((t) => t.id);
}

/**
 * Next set of "most recent" columns. With `refresh` the most recent `count` win; otherwise shown
 * threads stay while still eligible and freed slots are topped up from the most recent others.
 */
export function recentColumns(shown: string[], eligible: string[], count: number, refresh: boolean): string[] {
  if (refresh || shown.length === 0) return eligible.slice(0, count);
  const kept = shown.filter((id) => eligible.includes(id));
  return [...kept, ...eligible.filter((id) => !kept.includes(id))].slice(0, count);
}

export interface Resolution {
  ids: string[];
  unknown: string[];
}

/** Accepts full ids or a unique prefix/suffix (the short ids `--list` prints). */
export function resolveThreadIds(inputs: string[], threads: Iterable<ShellThread>): Resolution {
  const all = [...threads];
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const raw of inputs) {
    const input = raw.trim();
    if (!input) continue;
    if (all.some((t) => t.id === input)) {
      ids.push(input);
      continue;
    }
    const matches = all.filter((t) => t.id.startsWith(input) || t.id.endsWith(input));
    if (matches.length === 1) {
      ids.push(matches[0].id);
    } else if (matches.length > 1) {
      throw new Error(`"${input}" matches ${matches.length} threads; use a longer id.`);
    } else {
      // Possibly a thread the shell omits; subscribing directly will tell.
      ids.push(input);
      unknown.push(input);
    }
  }
  return { ids: [...new Set(ids)], unknown };
}

export function shortId(id: string): string {
  return id.startsWith("thread:") ? id.slice(-8) : id.slice(0, 8);
}
