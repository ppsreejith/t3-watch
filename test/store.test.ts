import assert from "node:assert/strict";
import { test } from "node:test";
import { ProvidersState, ShellState, ThreadState, MAX_THREAD_ITEMS } from "../src/store.js";

const thread = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, status: "idle", ...extra });

test("shell snapshot is authoritative; enrichment snapshot only patches projects", () => {
  const shell = new ShellState();
  shell.apply({ kind: "snapshot", snapshot: { snapshotSequence: 10, threads: [thread("a"), thread("b")], archivedThreads: [thread("z")], projects: [{ id: "p", title: "old" }] } });
  assert.equal(shell.threads.size, 3);
  assert.equal(shell.threads.get("z")?.location, "archive");
  shell.apply({ kind: "snapshot", snapshot: { snapshotSequence: 10, threads: [], archivedThreads: [], projects: [{ id: "p", title: "new" }] }, resolvedRepositoryIdentityRoots: ["/x"] });
  assert.equal(shell.threads.size, 3, "enrichment snapshot must not wipe threads");
  assert.equal(shell.projects.get("p")?.title, "new");
});

test("shell events upsert/remove and are gated by sequence", () => {
  const shell = new ShellState();
  shell.apply({ kind: "snapshot", snapshot: { snapshotSequence: 10, threads: [thread("a")] } });
  assert.equal(shell.apply({ kind: "thread.updated", sequence: 9, location: "active", thread: thread("a", { status: "running" }) }), false);
  assert.equal(shell.threads.get("a")?.status, "idle");
  shell.apply({ kind: "thread.updated", sequence: 11, location: "active", thread: thread("a", { status: "running" }) });
  shell.apply({ kind: "thread.updated", sequence: 12, location: "active", thread: thread("b") });
  assert.equal(shell.threads.get("a")?.status, "running");
  shell.apply({ kind: "thread.removed", sequence: 13, location: "active", threadId: "b" });
  assert.equal(shell.threads.has("b"), false);
  // A fresh snapshot (reconnect) resets the sequence baseline.
  shell.apply({ kind: "snapshot", snapshot: { snapshotSequence: 5, threads: [thread("c")] } });
  assert.deepEqual([...shell.threads.keys()], ["c"]);
});

const item = (id: string, ordinal: number, extra: Record<string, unknown> = {}) => ({ id, ordinal, type: "assistant_message", status: "completed", text: id, ...extra });

test("thread snapshot + streaming turn-item updates replace whole items in ordinal order", () => {
  const state = new ThreadState("t");
  state.apply({
    kind: "snapshot",
    snapshotSequence: 100,
    hasMoreHistory: true,
    projection: { thread: { id: "t", title: "Title", providerInstanceId: "codex" }, visibleTurnItems: [{ item: item("b", 2) }, { item: item("a", 1) }] },
  });
  assert.deepEqual(state.sorted().map((i) => i.id), ["a", "b"]);
  assert.equal(state.providerInstanceId, "codex");
  assert.equal(state.hasMoreHistory, true);

  const v = state.version;
  state.apply({ kind: "event", sequence: 101, event: { type: "turn-item.updated", payload: item("c", 3, { streaming: true, status: "running", text: "Hel" }) } });
  state.apply({ kind: "event", sequence: 102, event: { type: "turn-item.updated", payload: item("c", 3, { streaming: true, status: "running", text: "Hello wor" }) } });
  assert.equal(state.items.get("c")?.text, "Hello wor");
  assert.ok(state.version > v);
  // Stale/duplicate sequence is ignored.
  assert.equal(state.apply({ kind: "event", sequence: 102, event: { type: "turn-item.updated", payload: item("c", 3, { text: "stale" }) } }), false);
  state.apply({ kind: "event", sequence: 103, event: { type: "turn-item.updated", payload: item("c", 3, { streaming: false, text: "Hello world" }) } });
  assert.equal(state.items.get("c")?.streaming, false);
  assert.deepEqual(state.sorted().map((i) => i.id), ["a", "b", "c"]);

  state.apply({ kind: "event", sequence: 104, event: { type: "thread.metadata-updated", payload: { id: "t", title: "Renamed" } } });
  assert.equal(state.title, "Renamed");
  state.apply({ kind: "unknown-event" });
});

test("thread state caps item count", () => {
  const state = new ThreadState("t");
  const items = Array.from({ length: MAX_THREAD_ITEMS + 5 }, (_, i) => ({ item: item(`i${i}`, i) }));
  state.apply({ kind: "snapshot", snapshotSequence: 1, projection: { visibleTurnItems: items } });
  assert.equal(state.items.size, MAX_THREAD_ITEMS);
  assert.equal(state.sorted()[0].id, "i5");
  assert.equal(state.hasMoreHistory, true);
});

test("providers state reads snapshot and providerStatuses events", () => {
  const providers = new ProvidersState();
  providers.apply({ type: "snapshot", config: { providers: [{ instanceId: "claudeAgent", usageLimits: { windows: [] } }] } });
  providers.apply({ type: "providerStatuses", payload: { providers: [{ instanceId: "codex", usageLimits: { windows: [{ id: "w", kind: "weekly", label: "Weekly", usedPercent: 85 }] } }] } });
  assert.equal(providers.providers.get("codex")?.usageLimits?.windows[0].usedPercent, 85);
  assert.ok(providers.providers.has("claudeAgent"));
  assert.equal(providers.apply({ type: "keybindingsUpdated", payload: {} }), false);
});
