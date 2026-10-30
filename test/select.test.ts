import assert from "node:assert/strict";
import { test } from "node:test";
import { isSettled, pickThreads, recentColumns, resolveThreadIds, shortId } from "../src/select.js";
import type { LocatedThread } from "../src/store.js";

const t = (id: string, at: string, extra: Partial<LocatedThread> = {}): LocatedThread => ({
  id,
  location: "active",
  status: "completed",
  latestRunStartedAt: at,
  ...extra,
});

const threads = [
  t("aaaa1111", "2026-10-30T10:00:00Z"),
  t("bbbb2222", "2026-10-30T12:00:00Z"),
  t("cccc3333", "2026-10-30T11:00:00Z"),
  t("thread:delegated-task:xyz-ffff9999", "2026-10-30T13:00:00Z", { lineage: { relationshipToParent: "subagent" } }),
  t("dddd4444", "2026-10-30T14:00:00Z", { location: "archive", archivedAt: "2026-10-30T14:00:00Z" }),
  t("eeee5555", "2026-10-30T15:00:00Z", { deletedAt: "2026-10-30T15:00:00Z" }),
  t("gggg7777", "2026-10-30T16:00:00Z", { settledAt: "2026-10-30T16:30:00Z" }),
];

test("default pick: most recently active, unsettled, top-level threads", () => {
  const base = { subagents: false, settled: false };
  assert.deepEqual(pickThreads(threads, { ...base, count: 2 }), ["bbbb2222", "cccc3333"]);
  assert.deepEqual(pickThreads(threads, { ...base, subagents: true, count: 2 }), ["thread:delegated-task:xyz-ffff9999", "bbbb2222"]);
  assert.deepEqual(pickThreads(threads, base), ["bbbb2222", "cccc3333", "aaaa1111"]);
  assert.deepEqual(pickThreads(threads, { ...base, settled: true, count: 2 }), ["gggg7777", "dddd4444"]);
});

test("settled: settled/snoozed/archived, never while running or after being unsettled", () => {
  const now = Date.parse("2026-10-30T18:00:00Z");
  assert.equal(isSettled(t("a", "x", { settledAt: "2026-10-30T10:00:00Z" }), now), true);
  assert.equal(isSettled(t("a", "x", { settledAt: "2026-10-30T10:00:00Z", unsettledAt: "2026-10-30T11:00:00Z" }), now), false);
  assert.equal(isSettled(t("a", "x", { settledAt: "2026-10-30T10:00:00Z", status: "running" }), now), false);
  assert.equal(isSettled(t("a", "x", { snoozedUntil: "2026-10-31T00:00:00Z" }), now), true);
  assert.equal(isSettled(t("a", "x", { snoozedUntil: "2026-10-30T12:00:00Z" }), now), false);
  assert.equal(isSettled(t("a", "x", { location: "archive" }), now), true);
});

test("ids resolve by full id, prefix or suffix and keep the given order", () => {
  const { ids, unknown } = resolveThreadIds(["cccc", "aaaa1111", "ffff9999", "nope"], threads);
  assert.deepEqual(ids, ["cccc3333", "aaaa1111", "thread:delegated-task:xyz-ffff9999", "nope"]);
  assert.deepEqual(unknown, ["nope"]);
  assert.throws(() => resolveThreadIds(["a"], [t("ab", "x"), t("ac", "x")]), /matches 2 threads/);
  assert.equal(shortId("thread:delegated-task:xyz-ffff9999"), "ffff9999");
  assert.equal(shortId("733d94b5-4417"), "733d94b5");
});

test("recent columns: settled ones drop out live, freed slots refill, survivors keep their place", () => {
  // Shown a, b, c; b gets settled (no longer eligible) and d is the next most recent.
  assert.deepEqual(recentColumns(["a", "b", "c"], ["c", "a", "d", "e"], 3, false), ["a", "c", "d"]);
  // Nothing changed: order of shown columns is kept even if activity order differs.
  assert.deepEqual(recentColumns(["a", "b"], ["b", "a", "z"], 2, false), ["a", "b"]);
  // Refresh (r) or --follow: simply the most recent.
  assert.deepEqual(recentColumns(["a", "b"], ["z", "b", "a"], 2, true), ["z", "b"]);
  // A slot frees up when fewer than N were eligible and one becomes active (e.g. unsettled).
  assert.deepEqual(recentColumns(["a"], ["x", "a"], 3, false), ["a", "x"]);
});
