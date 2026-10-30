import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, selectionFor } from "../src/cli.js";
import { buildWsUrl } from "../src/config.js";
import { parseKeys } from "../src/ui.js";

test("argument parsing", () => {
  assert.deepEqual(selectionFor(parseArgs([])), { mode: "recent", count: 3 });
  assert.deepEqual(selectionFor(parseArgs(["-n", "4"])), { mode: "recent", count: 4 });
  assert.deepEqual(selectionFor(parseArgs(["-n5"])), { mode: "recent", count: 5 });
  assert.deepEqual(selectionFor(parseArgs(["--count=6"])), { mode: "recent", count: 6 });
  assert.deepEqual(selectionFor(parseArgs(["--all"])), { mode: "all" });
  assert.deepEqual(selectionFor(parseArgs(["b", "a"])), { mode: "ids", ids: ["b", "a"] });
  assert.equal(parseArgs(["--select"]).select, true);
  assert.equal(parseArgs(["--no-usage"]).usage, false);
  assert.equal(parseArgs(["--print", "abc"]).print, "abc");
  assert.throws(() => parseArgs(["-n", "0"]), /Invalid count/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown option/);
  assert.throws(() => parseArgs(["--all", "x"]), /cannot be combined/);
});

test("ws url always pins orchestration protocol 2", () => {
  assert.equal(buildWsUrl("http://127.0.0.1:3773"), "ws://127.0.0.1:3773/ws?orchestrationProtocol=2");
  assert.equal(buildWsUrl("https://box.example/app?x=1"), "wss://box.example/ws?orchestrationProtocol=2");
  assert.equal(buildWsUrl("localhost:4000"), "ws://localhost:4000/ws?orchestrationProtocol=2");
});

test("key parsing", () => {
  assert.deepEqual(parseKeys("\x1b[A\x1b[B\x1b[C\x1b[Dq"), ["up", "down", "right", "left", "q"]);
  assert.deepEqual(parseKeys("\x1b[5~\x1b[6~\x1b"), ["pageup", "pagedown", "escape"]);
  assert.deepEqual(parseKeys("\x1b[1;5Ca"), ["a"]);
  assert.deepEqual(parseKeys("\x1b[1;2D\x1b[1;2C"), ["shift-left", "shift-right"]);
});
