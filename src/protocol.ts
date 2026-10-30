/**
 * Wire types for T3 Code's orchestration protocol 2: Effect RPC over a WebSocket at
 * `/ws?orchestrationProtocol=2`, one JSON frame per message.
 *
 * Only the fields t3-watch reads are typed; everything else passes through untouched.
 */

export const ORCHESTRATION_PROTOCOL_VERSION = 2;

/** Every RPC t3-watch may call. All are streaming reads gated by the `orchestration:read` scope. */
export const METHODS = {
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  subscribeServerConfig: "subscribeServerConfig",
} as const;

export type ReadOnlyMethod = (typeof METHODS)[keyof typeof METHODS];

const READ_ONLY_METHODS: ReadonlySet<string> = new Set(Object.values(METHODS));

/** The client refuses to put anything else on the wire, whatever the token allows. */
export function assertReadOnlyMethod(method: string): asserts method is ReadOnlyMethod {
  if (!READ_ONLY_METHODS.has(method)) {
    throw new Error(`t3-watch is read-only and refuses to call ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Shell (thread list)

export interface ShellThread {
  id: string;
  title?: string | null;
  projectId?: string;
  providerInstanceId?: string;
  modelSelection?: { model?: string } | null;
  branch?: string | null;
  status?: string;
  activityRunStatus?: string | null;
  pendingRuntimeRequest?: { kind?: string; blocking?: boolean } | null;
  lastError?: unknown;
  lineage?: {
    parentThreadId?: string | null;
    relationshipToParent?: string | null;
    rootThreadId?: string;
  } | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
  settledAt?: string | null;
  unsettledAt?: string | null;
  snoozedUntil?: string | null;
  createdAt?: string;
  updatedAt?: string;
  latestRunStartedAt?: string | null;
  latestRunCompletedAt?: string | null;
  activityRunStartedAt?: string | null;
  latestUserMessageAt?: string | null;
}

export interface ProjectShell {
  id: string;
  title?: string;
  workspaceRoot?: string;
}

export interface ShellSnapshot {
  snapshotSequence: number;
  threads: ShellThread[];
  archivedThreads?: ShellThread[];
  projects?: ProjectShell[];
}

export type ShellStreamItem =
  | { kind: "synchronized" }
  | { kind: "snapshot"; snapshot: ShellSnapshot; resolvedRepositoryIdentityRoots?: string[] }
  | { kind: "project.updated"; sequence: number; project: ProjectShell }
  | { kind: "project.removed"; sequence: number; projectId: string }
  | { kind: "thread.updated"; sequence: number; location: "active" | "archive"; thread: ShellThread }
  | { kind: "thread.removed"; sequence: number; location: "active" | "archive"; threadId: string };

// ---------------------------------------------------------------------------
// Thread detail

/** T3 normalises Claude Code and Codex output into the same provider-agnostic turn items. */
export interface TurnItem {
  id: string;
  type: string;
  ordinal: number;
  threadId?: string;
  status?: string;
  title?: string | null;
  updatedAt?: string;
  text?: string;
  streaming?: boolean;
  [field: string]: unknown;
}

export interface AppThread {
  id: string;
  title?: string | null;
  providerInstanceId?: string;
  deletedAt?: string | null;
}

export interface ThreadProjection {
  thread?: AppThread;
  turnItems?: TurnItem[];
  visibleTurnItems?: Array<{ item?: TurnItem } & Partial<TurnItem>>;
}

export interface DomainEvent {
  type: string;
  payload?: unknown;
}

export type ThreadStreamItem =
  | { kind: "synchronized" }
  | {
      kind: "snapshot";
      snapshotSequence: number;
      projection: ThreadProjection;
      historyCursor?: string | null;
      hasMoreHistory?: boolean;
    }
  | { kind: "event"; sequence: number; event: DomainEvent };

// ---------------------------------------------------------------------------
// Server config (provider status + usage limits)

export interface UsageWindow {
  id: string;
  kind: "session" | "weekly" | "monthly" | "other" | string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  windowDurationMins?: number;
}

export interface UsageLimits {
  checkedAt?: string;
  windows: UsageWindow[];
  resetCredits?: { availableCount: number; nextExpiresAt?: string };
  unavailable?: { reason: string; message?: string };
}

export interface ProviderStatus {
  instanceId: string;
  driver?: string;
  displayName?: string;
  enabled?: boolean;
  installed?: boolean;
  status?: string;
  version?: string | null;
  message?: string;
  auth?: { status?: string; type?: string; label?: string };
  checkedAt?: string;
  usageLimits?: UsageLimits;
}

export type ServerConfigStreamItem =
  | { type: "snapshot"; config: { providers?: ProviderStatus[] } }
  | { type: "providerStatuses"; payload: { providers?: ProviderStatus[] } }
  | { type: string; payload?: unknown; config?: unknown };

// ---------------------------------------------------------------------------
// Effect RPC frames

export type ClientFrame =
  | { _tag: "Request"; id: string; tag: ReadOnlyMethod; payload: unknown; headers: [] }
  | { _tag: "Ack"; requestId: string }
  | { _tag: "Interrupt"; requestId: string }
  | { _tag: "Ping" }
  | { _tag: "Pong" };

export type ServerFrame =
  | { _tag: "Chunk"; requestId: string; values: unknown[] }
  | { _tag: "Exit"; requestId: string; exit: { _tag: "Success" | "Failure"; [k: string]: unknown } }
  | { _tag: "Defect"; defect: unknown }
  | { _tag: "ClientProtocolError"; error: unknown }
  | { _tag: "Ping" }
  | { _tag: "Pong" };

/** Pulls the most useful human message out of an Effect Exit/Cause/defect blob. */
export function describeFailure(value: unknown): string {
  const messages: string[] = [];
  const tags: string[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 8 || node == null) return;
    if (typeof node === "string") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (typeof record.message === "string" && record.message.trim()) messages.push(record.message.trim());
      if (typeof record._tag === "string" && /Error$/.test(record._tag)) tags.push(record._tag);
      for (const child of Object.values(record)) visit(child, depth + 1);
    }
  };
  visit(value, 0);
  if (messages.length > 0) return messages[0];
  if (tags.length > 0) return tags[0];
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value).slice(0, 200);
  } catch {
    return "unknown failure";
  }
}
