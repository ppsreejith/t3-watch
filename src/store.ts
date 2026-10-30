import type {
  ProjectShell,
  ProviderStatus,
  ServerConfigStreamItem,
  ShellStreamItem,
  ShellThread,
  ThreadStreamItem,
  TurnItem,
} from "./protocol.js";

export type LocatedThread = ShellThread & { location: "active" | "archive" };

/** Thread list kept in sync with `orchestration.subscribeShell`. */
export class ShellState {
  readonly threads = new Map<string, LocatedThread>();
  readonly projects = new Map<string, ProjectShell>();
  sequence = -1;
  loaded = false;

  apply(item: ShellStreamItem): boolean {
    switch (item.kind) {
      case "snapshot": {
        if (item.resolvedRepositoryIdentityRoots !== undefined) {
          // Enrichment patch: refreshed projects only, with deliberately empty thread lists.
          for (const project of item.snapshot.projects ?? []) this.projects.set(project.id, project);
          return true;
        }
        this.threads.clear();
        for (const thread of item.snapshot.threads ?? []) this.threads.set(thread.id, { ...thread, location: "active" });
        for (const thread of item.snapshot.archivedThreads ?? []) this.threads.set(thread.id, { ...thread, location: "archive" });
        this.projects.clear();
        for (const project of item.snapshot.projects ?? []) this.projects.set(project.id, project);
        this.sequence = item.snapshot.snapshotSequence ?? -1;
        this.loaded = true;
        return true;
      }
      case "thread.updated":
        if (!this.accept(item.sequence)) return false;
        this.threads.set(item.thread.id, { ...item.thread, location: item.location });
        return true;
      case "thread.removed": {
        if (!this.accept(item.sequence)) return false;
        const existing = this.threads.get(item.threadId);
        if (existing && existing.location === item.location) this.threads.delete(item.threadId);
        return true;
      }
      case "project.updated":
        if (!this.accept(item.sequence)) return false;
        this.projects.set(item.project.id, item.project);
        return true;
      case "project.removed":
        if (!this.accept(item.sequence)) return false;
        this.projects.delete(item.projectId);
        return true;
      default:
        return false;
    }
  }

  private accept(sequence: number | undefined): boolean {
    if (typeof sequence !== "number") return true;
    if (sequence <= this.sequence) return false;
    this.sequence = sequence;
    return true;
  }
}

/** Bounds memory for very long conversations; the oldest items are dropped first. */
export const MAX_THREAD_ITEMS = 3000;

/** One conversation kept in sync with `orchestration.subscribeThread`. */
export class ThreadState {
  readonly items = new Map<string, TurnItem>();
  sequence = -1;
  loaded = false;
  hasMoreHistory = false;
  title: string | undefined;
  providerInstanceId: string | undefined;
  error: string | undefined;
  version = 0;
  private sortedCache: TurnItem[] | undefined;

  constructor(readonly threadId: string) {}

  apply(item: ThreadStreamItem | { kind: string }): boolean {
    if (item.kind === "snapshot") {
      const snapshot = item as Extract<ThreadStreamItem, { kind: "snapshot" }>;
      const projection = snapshot.projection ?? {};
      this.items.clear();
      const visible = projection.visibleTurnItems;
      const source = visible
        ? visible.map((entry) => (entry.item ?? entry) as TurnItem)
        : (projection.turnItems ?? []);
      for (const turnItem of source) if (turnItem?.id) this.items.set(turnItem.id, turnItem);
      if (projection.thread) {
        this.title = projection.thread.title ?? this.title;
        this.providerInstanceId = projection.thread.providerInstanceId ?? this.providerInstanceId;
      }
      this.hasMoreHistory = Boolean(snapshot.hasMoreHistory);
      this.sequence = snapshot.snapshotSequence ?? -1;
      this.loaded = true;
      this.error = undefined;
      this.trim();
      this.changed();
      return true;
    }
    if (item.kind !== "event") return false;
    const { sequence, event } = item as Extract<ThreadStreamItem, { kind: "event" }>;
    if (typeof sequence === "number") {
      if (sequence <= this.sequence) return false;
      this.sequence = sequence;
    }
    const payload = event?.payload as Record<string, any> | undefined;
    if (!payload) return false;
    switch (event.type) {
      case "turn-item.updated":
        if (typeof payload.id !== "string") return false;
        // Every update carries the whole item, so partial streaming text simply replaces.
        this.items.set(payload.id, payload as TurnItem);
        this.trim();
        this.changed();
        return true;
      default:
        if (event.type.startsWith("thread.") && typeof payload.id === "string" && payload.id === this.threadId) {
          if (typeof payload.title === "string") this.title = payload.title;
          if (typeof payload.providerInstanceId === "string") this.providerInstanceId = payload.providerInstanceId;
          this.changed();
          return true;
        }
        return false;
    }
  }

  sorted(): TurnItem[] {
    if (!this.sortedCache) {
      this.sortedCache = [...this.items.values()].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    }
    return this.sortedCache;
  }

  private trim(): void {
    if (this.items.size <= MAX_THREAD_ITEMS) return;
    const ordered = [...this.items.values()].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    for (const old of ordered.slice(0, ordered.length - MAX_THREAD_ITEMS)) this.items.delete(old.id);
    this.hasMoreHistory = true;
  }

  private changed(): void {
    this.sortedCache = undefined;
    this.version++;
  }
}

/** Provider statuses (including usage-limit windows) from `subscribeServerConfig`. */
export class ProvidersState {
  readonly providers = new Map<string, ProviderStatus>();
  loaded = false;

  apply(item: ServerConfigStreamItem): boolean {
    let list: ProviderStatus[] | undefined;
    if (item.type === "snapshot") list = (item.config as { providers?: ProviderStatus[] } | undefined)?.providers;
    else if (item.type === "providerStatuses") list = (item.payload as { providers?: ProviderStatus[] } | undefined)?.providers;
    if (!Array.isArray(list)) return false;
    if (item.type === "snapshot") this.providers.clear();
    for (const provider of list) if (provider?.instanceId) this.providers.set(provider.instanceId, provider);
    this.loaded = true;
    return true;
  }
}
