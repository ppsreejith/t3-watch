import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown, type Line } from "../src/markdown.js";
import { textWidth } from "../src/text.js";

const text = (lines: Line[]) => lines.map((l) => l.map((s) => s[0]).join(""));
const styleOf = (lines: Line[], needle: string) => lines.flat().find((s) => s[0].includes(needle))?.[1];

test("inline styles: bold, italic, code, links, entities", () => {
  const lines = renderMarkdown("Some **bold *both*** and `a<b>` with [docs](https://x.dev) &amp; done.", 80);
  assert.deepEqual(text(lines), ["Some bold both and a<b> with docs & done."]);
  assert.equal(styleOf(lines, "bold"), "strong");
  assert.equal(styleOf(lines, "both"), "strong+em");
  assert.equal(styleOf(lines, "a<b>"), "code");
  assert.equal(styleOf(lines, "docs"), "link");
});

test("blocks: headings, lists, quotes, code, rules", () => {
  const lines = renderMarkdown("# Title\n\n- one\n  - nested\n- [x] done\n\n1. first\n2. second\n\n> quoted **b**\n\n```ts\nconst x = 1;\n```\n\n---", 30);
  assert.deepEqual(text(lines), [
    "Title",
    "",
    "• one",
    "  • nested",
    "☑ done",
    "",
    "1. first",
    "2. second",
    "",
    "│ quoted b",
    "",
    " const x = 1;                 ",
    "",
    "──────────────────────────────",
  ]);
  assert.equal(styleOf(lines, "Title"), "h1");
  assert.equal(lines[9][2][1], "strong+quote");
  assert.equal(styleOf(lines, "const"), "codeBlock");
});

test("wrapping keeps hanging indents and never exceeds the width", () => {
  const lines = renderMarkdown("- **Plugin v0.6.0** describes the older authenticated MCP tools and the JSX component kit.", 24);
  for (const line of text(lines)) assert.ok(textWidth(line) <= 24, line);
  assert.equal(text(lines)[0].slice(0, 2), "• ");
  assert.ok(text(lines).slice(1).every((l) => l.startsWith("  ")));
});

test("tables align when they fit and fall back to label: value rows when not", () => {
  const md = "| Agent | Reads .agents |\n|---|---|\n| Codex | yes |\n| Claude | no |";
  assert.deepEqual(text(renderMarkdown(md, 40)), ["Agent  │ Reads .agents", "───────┼──────────────", "Codex  │ yes          ", "Claude │ no           "]);
  assert.deepEqual(text(renderMarkdown(md, 12)), ["Agent: Codex", "Reads", ".agents: yes", "", "Agent:", "Claude", "Reads", ".agents: no"]);
});

test("unfinished syntax while streaming stays readable", () => {
  assert.deepEqual(text(renderMarkdown("partial **bo", 40)), ["partial **bo"]);
  assert.deepEqual(text(renderMarkdown("```js\nconst a", 40)), [" const a" + " ".repeat(32)]);
});
