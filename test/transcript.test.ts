import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadState } from "../src/store.js";
import {
  Transcript,
  findMatches,
  foldBack,
  focusIndex,
  makeQuery,
  occurrences,
  moveFocus,
  revealItem,
  structure,
} from "../src/transcript.js";

const items = [
  { id: "u1", ordinal: 1, type: "user_message", text: "Fix the navbar" },
  { id: "r1", ordinal: 2, type: "reasoning", text: "Look at App.tsx first" },
  { id: "c1", ordinal: 3, type: "command_execution", status: "completed", input: "grep -n Navbar src", output: "src/App.tsx:12: <Navbar/>" },
  { id: "t1", ordinal: 4, type: "dynamic_tool", status: "completed", toolName: "Edit", input: { file_path: "src/App.tsx" } },
  { id: "k1", ordinal: 5, type: "checkpoint" },
  { id: "a1", ordinal: 6, type: "assistant_message", text: "Fixed the navbar overflow." },
  { id: "c2", ordinal: 7, type: "command_execution", status: "running", input: "npm test" },
];

function thread(list = items) {
  const state = new ThreadState("t");
  state.apply({ kind: "snapshot", snapshotSequence: 1, projection: { visibleTurnItems: list.map((item) => ({ item })) } });
  return state;
}

test("steps between messages fold into one group; lone steps stand alone; bookkeeping is hidden", () => {
  const entries = structure(thread().sorted());
  assert.deepEqual(entries.map((e) => `${e.kind}:${e.key}`), ["message:u1", "group:group:r1", "message:a1", "step:c2"]);
  assert.equal(entries[1].steps!.length, 3);
});

test("folded layout is compact, expanding a group shows one line per step, steps open to detail", () => {
  const state = thread();
  const transcript = new Transcript();
  const text = () => transcript.layout(state, 60).rows.map((r) => r.text);
  assert.deepEqual(text(), [
    "▌ Fix the navbar",
    "",
    "▸ 3 steps · thinking · shell · Edit",
    "",
    "Fixed the navbar overflow.",
    "",
    "⟳ $ npm test",
  ]);
  const group = transcript.layout(state, 60).entries[1];
  transcript.toggle(group);
  assert.deepEqual(text().slice(2, 6), ["▾ 3 steps · thinking · shell · Edit", "  ∴ Look at App.tsx first", "  ✓ $ grep -n Navbar src", "  ✓ Edit src/App.tsx"]);
  transcript.toggle({ key: "c1", kind: "step" });
  assert.ok(text().includes("  │ src/App.tsx:12: <Navbar/>"));
  transcript.setAllGroups(state, false);
  assert.equal(text()[2], "▸ 3 steps · thinking · shell · Edit");
});

test("long messages fold to three lines", () => {
  const state = thread([{ id: "a", ordinal: 1, type: "assistant_message", text: "1\n2\n3\n4\n5\n6" }]);
  const transcript = new Transcript();
  transcript.toggle({ key: "a", kind: "message" });
  assert.deepEqual(transcript.layout(state, 40).rows.map((r) => r.text), ["1", "2", "3", "  … 3 more lines"]);
});

test("focus moves between entries and scrolls through tall ones line by line", () => {
  const state = thread([
    { id: "a", ordinal: 1, type: "assistant_message", text: "a" },
    { id: "b", ordinal: 2, type: "assistant_message", text: "b1\nb2\nb3\nb4\nb5" },
    { id: "c", ordinal: 3, type: "assistant_message", text: "c" },
  ]);
  const layout = new Transcript().layout(state, 40);
  // rows: a, "", b1..b5, "", c  (9 rows); viewport of 3 rows at the bottom.
  let pos = { focus: 2, top: 6 };
  pos = moveFocus(layout, pos.focus, pos.top, 3, -1);
  assert.deepEqual(pos, { focus: 1, top: 4 }, "moving up onto a tall entry shows its end");
  pos = moveFocus(layout, pos.focus, pos.top, 3, -1);
  assert.deepEqual(pos, { focus: 1, top: 3 }, "then scrolls within it");
  pos = moveFocus(layout, pos.focus, pos.top, 3, -1);
  pos = moveFocus(layout, pos.focus, pos.top, 3, -1);
  assert.deepEqual(pos, { focus: 0, top: 0 });
  assert.equal(focusIndex(layout, "missing"), 2, "unknown keys fall back to the last entry");
});

test("search finds text hidden inside folded steps and unfolds just enough to show it", () => {
  const state = thread();
  const transcript = new Transcript();
  const query = makeQuery("<navbar/>");
  const matches = findMatches(state, query);
  assert.deepEqual(matches.map((m) => m.id), ["c1"]);
  const opened = revealItem(transcript, state, matches[0], query);
  assert.deepEqual(opened.map((e) => e.key), ["group:r1", "c1"]);
  const layout = transcript.layout(state, 60);
  const i = focusIndex(layout, "c1");
  const hits = occurrences(layout, i, query);
  assert.equal(hits.length, 1);
  assert.equal(layout.rows[hits[0].row].text.slice(hits[0].at, hits[0].at + 9), "<Navbar/>");
  foldBack(transcript, opened);
  assert.equal(transcript.layout(state, 60).rows[2].text, "▸ 3 steps · thinking · shell · Edit");
  // If the user folds everything in between, folding back must not re-open anything.
  const again = revealItem(transcript, state, matches[0], query);
  transcript.setAllGroups(state, false);
  foldBack(transcript, again);
  assert.equal(transcript.isExpanded({ key: "group:r1", kind: "group" }), false);
  assert.equal(transcript.isExpanded({ key: "c1", kind: "step" }), false);
  assert.deepEqual(findMatches(state, makeQuery("NAVBAR")).length, 0, "capitals make the search case-sensitive");
  assert.deepEqual(findMatches(state, makeQuery("navbar")).map((m) => m.id), ["u1", "c1", "a1"]);
});

test("folded step summaries are cached and only look at the start of huge thinking", () => {
  const huge = "word ".repeat(200_000);
  const state = thread([
    { id: "u", ordinal: 1, type: "user_message", text: "hi" },
    { id: "r", ordinal: 2, type: "reasoning", text: huge },
    { id: "a", ordinal: 3, type: "assistant_message", text: "done" },
  ]);
  const transcript = new Transcript();
  const first = transcript.layout(state, 60).rows[2];
  assert.match(first.text, /^∴ word word/);
  state.apply({ kind: "event", sequence: 2, event: { type: "turn-item.updated", payload: { id: "a", ordinal: 3, type: "assistant_message", text: "done!" } } });
  const started = performance.now();
  const second = transcript.layout(state, 60).rows[2];
  assert.ok(performance.now() - started < 50);
  assert.deepEqual(second, first);
});
