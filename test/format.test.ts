import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, layoutBlocks, messageBlocks, stepDetail, stepSummary, threadActivity, threadStatus, usageBar, usageLines } from "../src/format.js";
import { ThreadState } from "../src/store.js";
import { highlight } from "../src/render.js";
import { makeQuery } from "../src/transcript.js";
import { fit, sanitize, textWidth, wrapText } from "../src/text.js";

test("wrapText respects cell width for wide characters and breaks words", () => {
  for (const row of wrapText("日本語のテキストと emoji 🎉🎉 mixed with ascii words", 10)) assert.ok(textWidth(row) <= 10, row);
  assert.deepEqual(wrapText("hello world foo", 11), ["hello world", "foo"]);
  assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrapText("a\n\nb", 5), ["a", "", "b"]);
});

test("fit pads and truncates to exact width", () => {
  assert.equal(fit("abc", 5), "abc  ");
  assert.equal(fit("abcdef", 4), "abc…");
  assert.equal(textWidth(fit("日本語テキスト", 5)), 5);
});

test("sanitize strips escapes, control chars and carriage-return redraws", () => {
  assert.equal(sanitize("\x1b[31mred\x1b[0m\tx"), "red  x");
  assert.equal(sanitize("10%\r50%\r100%\ndone"), "100%\ndone");
  assert.equal(sanitize("bell\x07!"), "bell!");
});

test("messages, step summaries and step details", () => {
  const user = messageBlocks({ id: "1", ordinal: 1, type: "user_message", text: "Fix navbar" });
  assert.deepEqual(layoutBlocks(user, 8).map((r) => r.text), ["▌ Fix", "▌ navbar"]);
  assert.match(messageBlocks({ id: "2", ordinal: 2, type: "assistant_message", text: "Partial", streaming: true })[0].text, /Partial ▍$/);
  const cmd = { id: "3", ordinal: 3, type: "command_execution", status: "completed", input: "npm test", exitCode: 1, output: "a\nb\nc" };
  assert.deepEqual(stepSummary(cmd), { prefix: "✗ ", text: "$ npm test (exit 1)", style: "toolErr" });
  assert.deepEqual(stepDetail(cmd).map((b) => b.prefix + b.text), ["✗ $ npm test", "│ a", "│ b", "│ c"]);
  const tool = stepSummary({ id: "4", ordinal: 4, type: "dynamic_tool", status: "running", toolName: "Read", input: { file_path: "/x/App.tsx" } });
  assert.equal(tool.prefix + tool.text, "⟳ Read /x/App.tsx");
  const thinking = { id: "5", ordinal: 5, type: "reasoning", text: "line one\nline two", streaming: false };
  assert.equal(stepSummary(thinking).text, "line one line two");
  assert.equal(stepDetail(thinking)[0].text, "line one\nline two");
});

test("thread status and activity", () => {
  const state = new ThreadState("t");
  state.apply({
    kind: "snapshot",
    snapshotSequence: 1,
    projection: { visibleTurnItems: [{ item: { id: "a", ordinal: 3, type: "assistant_message", text: "Hel", streaming: true, status: "running" } }] },
  });
  assert.equal(threadActivity(state, { id: "t", status: "running" }).label, "Streaming");
  assert.equal(threadStatus({ id: "t", status: "running" }).label, "Running");
  assert.equal(threadStatus({ id: "t", status: "completed" }).label, "Idle");
  assert.equal(threadStatus({ id: "t", status: "running", pendingRuntimeRequest: { kind: "approval" } }).label, "Waiting for you");
});

test("usage formatting", () => {
  assert.equal(formatDuration(4 * 86_400_000 + 15 * 3_600_000 + 5 * 60_000), "4d 15h");
  assert.equal(formatDuration(4 * 3_600_000 + 55 * 60_000), "4h 55m");
  assert.equal(formatDuration(30_000), "<1m");
  assert.equal(usageBar(33, 10), "███░░░░░░░");
  const now = Date.parse("2026-10-30T13:00:00Z");
  const lines = usageLines(
    "claudeAgent",
    {
      instanceId: "claudeAgent",
      auth: { label: "Claude Max Subscription" },
      usageLimits: {
        checkedAt: "2026-10-30T12:58:00Z",
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 0, resetsAt: "2026-10-30T18:00:00Z" }],
      },
    },
    24,
    now,
  );
  const text = lines.map((l) => l.parts.map((p) => p[0]).join(""));
  assert.equal(text[0], "Claude · Claude Max");
  assert.equal(text[1], "Session               0%");
  assert.equal(text[2], "░".repeat(24));
  assert.match(text[3], /^resets in 5h · /);
  assert.equal(text[4], "checked 2m ago");
  const codex = usageLines("codex", { instanceId: "codex", usageLimits: { windows: [], unavailable: { reason: "probeFailed" } } }, 24, now);
  assert.match(codex[1].parts[0][0], /probeFailed/);
  assert.equal(usageLines("codex", undefined, 24)[1].parts[0][0], "Not reported by T3");
});

test("search highlighting", () => {
  assert.deepEqual(highlight([["Fix the Navbar now", "plain"]], makeQuery("navbar")), [["Fix the ", "plain"], ["Navbar", "match"], [" now", "plain"]]);
  assert.deepEqual(highlight([["a foo foo", "plain"]], makeQuery("foo"), 2).map((p) => p[1]), ["plain", "matchCurrent", "plain", "match"]);
  assert.deepEqual(highlight([["a foo foo", "plain"]], makeQuery("foo"), 6).map((p) => p[1]), ["plain", "match", "plain", "matchCurrent"]);
  // A hit spanning two styled parts (e.g. across **bold**) is still painted as one hit.
  assert.deepEqual(highlight([["see fo", "plain"], ["obar", "strong"]], makeQuery("foob")), [["see ", "plain"], ["foob", "match"], ["ar", "strong"]]);
  assert.deepEqual(highlight([["İstanbul foo", "plain"]], makeQuery("foo")), [["İstanbul foo", "plain"]], "no misplaced highlight");
  assert.equal(sanitize("ok\x9b31m"), "ok31m", "C1 controls are stripped");
});
