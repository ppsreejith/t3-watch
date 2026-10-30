import type { ProviderStatus, ShellThread, TurnItem, UsageWindow } from "./protocol.js";
import type { ThreadState } from "./store.js";
import { renderMarkdown } from "./markdown.js";
import { clip, sanitize, textWidth, wrapText, type Span } from "./text.js";

export type Style =
  | "plain"
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "toolRun"
  | "toolErr"
  | "dim"
  | "warn"
  | "error";

export type Tone = "good" | "warn" | "bad" | "dim" | "info";

/** A logical line. `prefix` starts the first wrapped row; `cont` (default: spaces) starts the rest. */
export interface Block {
  prefix: string;
  text: string;
  style: Style;
  cont?: string;
}

export interface Row {
  text: string;
  style: Style;
  /** Styled pieces (Markdown); when absent the whole row paints in `style`. */
  parts?: Span[];
}

const MAX_TEXT_CHARS = 40_000;
const DETAIL_TAIL_LINES = 40;

export const str = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const firstLine = (text: string): string => {
  const trimmed = text.trim();
  const newline = trimmed.indexOf("\n");
  return newline === -1 ? trimmed : `${trimmed.slice(0, newline)} …`;
};

/** Server-provided labels (titles, branches, errors) are untrusted: one safe line. */
export const label = (value: unknown, max = 300): string => oneLine(sanitize(str(value)), max);

/** Drops inline Markdown markers (bold, italic, code, links, heading hashes) for one-line summaries. */
export const stripMarkdown = (text: string): string =>
  text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, "$1$2")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "");

export const oneLine = (text: string, max = 240): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
};

function tail(text: string, count: number): { lines: string[]; dropped: number } {
  const lines = sanitize(text).replace(/\n+$/, "").split("\n");
  if (lines.length <= count) return { lines, dropped: 0 };
  return { lines: lines.slice(-count), dropped: lines.length - count };
}

const INPUT_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt", "name"];

/** Short human summary of a tool's input object. */
export function summarizeInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return oneLine(input, 160);
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of INPUT_KEYS) {
      if (typeof record[key] === "string" && (record[key] as string).trim()) return oneLine(record[key] as string, 160);
    }
  }
  return oneLine(str(input), 160);
}

// ---------------------------------------------------------------------------
// Item classification

/** Conversation-level items; everything else between them is a collapsible "step". */
const MESSAGE_TYPES = new Set([
  "user_message",
  "assistant_message",
  "error",
  "approval_request",
  "user_input_request",
  "proposed_plan",
  "todo_list",
]);

/** Bookkeeping items with nothing to show. */
const HIDDEN_TYPES = new Set(["checkpoint", "run", "node", "provider_thread", "thread_created", "fork"]);

export const isMessage = (item: TurnItem): boolean => MESSAGE_TYPES.has(item.type);

export function isVisible(item: TurnItem): boolean {
  if (HIDDEN_TYPES.has(item.type)) return false;
  if (item.type === "assistant_message") return Boolean(item.streaming || (typeof item.text === "string" && item.text.trim()));
  if (item.type === "reasoning") return Boolean(item.streaming || (typeof item.text === "string" && item.text.trim()));
  if (item.type === "notification") return Boolean(str(item.title ?? item.message ?? item.text));
  if (["system_notice", "run_interrupt_request", "run_interrupt_result"].includes(item.type)) return Boolean(str(item.message));
  return true;
}

export const isLive = (item: TurnItem): boolean =>
  item.streaming === true || item.status === "running" || item.status === "pending";

function isFailed(item: TurnItem): boolean {
  if (item.status === "failed") return true;
  if (item.type === "command_execution") {
    return item.outputIndicatesFailure === true || (typeof item.exitCode === "number" && item.exitCode !== 0);
  }
  return false;
}

export const stepFailed = isFailed;

/** Label used when counting steps in a collapsed group. */
export function stepKind(item: TurnItem): string {
  switch (item.type) {
    case "reasoning":
      return "thinking";
    case "command_execution":
      return "shell";
    case "dynamic_tool":
      return str(item.toolName) || "tool";
    case "file_change":
      return "edit";
    case "file_search":
    case "web_search":
      return "search";
    case "subagent":
      return "subagent";
    default:
      return "note";
  }
}

function icon(item: TurnItem): string {
  if (isLive(item)) return "⟳ ";
  if (isFailed(item)) return "✗ ";
  if (item.status === "cancelled" || item.status === "interrupted") return "◌ ";
  return "✓ ";
}

function stepStyle(item: TurnItem): Style {
  if (isLive(item)) return "toolRun";
  return isFailed(item) ? "toolErr" : "tool";
}

// ---------------------------------------------------------------------------
// Rendering items

/** Blocks for a conversation-level item. `collapsed` messages are cut by the transcript. */
export function messageBlocks(item: TurnItem): Block[] {
  const text = typeof item.text === "string" ? sanitize(item.text).trim() : "";
  switch (item.type) {
    case "user_message":
      return [{ prefix: "▌ ", cont: "▌ ", text: clip(text, MAX_TEXT_CHARS) || "(attachment)", style: "user" }];
    case "assistant_message":
      return [{ prefix: "", text: `${clip(text, MAX_TEXT_CHARS) || "…"}${item.streaming ? " ▍" : ""}`, style: "assistant" }];
    case "error": {
      const failure = item.failure as Record<string, unknown> | undefined;
      return [{ prefix: "✗ ", text: oneLine(sanitize(str(failure?.message ?? failure)), 600), style: "error" }];
    }
    case "approval_request": {
      const what = str(item.prompt) || str(item.reason) || str(item.requestKind) || "approval";
      const open = isLive(item);
      return [{ prefix: "⚠ ", text: `Approval ${open ? "requested" : "request"}: ${oneLine(sanitize(what), 400)}`, style: open ? "warn" : "dim" }];
    }
    case "user_input_request": {
      const questions = Array.isArray(item.questions) ? (item.questions as Array<Record<string, unknown>>) : [];
      const asked = questions.map((q) => str(q.question ?? q.prompt ?? q.header ?? q)).join(" / ") || "Input requested";
      return [{ prefix: "? ", text: oneLine(sanitize(asked), 400), style: isLive(item) ? "warn" : "dim" }];
    }
    case "todo_list": {
      const steps = Array.isArray(item.steps) ? (item.steps as Array<Record<string, unknown>>) : [];
      const blocks: Block[] = [{ prefix: "☰ ", text: "Plan", style: "tool" }];
      for (const step of steps.slice(0, 20)) {
        const status = str(step.status);
        const mark = status === "completed" ? "[x]" : status === "in_progress" || status === "inProgress" ? "[~]" : "[ ]";
        blocks.push({ prefix: `  ${mark} `, text: str(step.step ?? step.text ?? step.title ?? step.content), style: status === "completed" ? "dim" : "plain" });
      }
      return blocks;
    }
    case "proposed_plan":
      return [
        { prefix: "☰ ", text: `Proposed plan${item.streaming ? " ▍" : ""}`, style: "tool" },
        { prefix: "  ", text: sanitize(str(item.markdown)), style: "plain" },
      ];
    default:
      return [];
  }
}

/** One-line summary of a step (thinking, command, tool call, …). */
export function stepSummary(item: TurnItem): Block {
  // Only the start is shown, so don't sanitize megabytes of thinking for one line.
  const text = typeof item.text === "string" ? sanitize(item.text.slice(0, 2000)) : "";
  switch (item.type) {
    case "reasoning":
      return { prefix: "∴ ", text: (oneLine(stripMarkdown(text), 300) || "Thinking…") + (item.streaming ? " ▍" : ""), style: "reasoning" };
    case "command_execution": {
      const input = sanitize(str(item.input));
      const label = input.trim() ? `$ ${firstLine(input)}` : (item.title ?? "command");
      const exit = isFailed(item) && typeof item.exitCode === "number" && item.exitCode !== 0 ? ` (exit ${item.exitCode})` : "";
      return { prefix: icon(item), text: oneLine(label, 300) + exit, style: stepStyle(item) };
    }
    case "dynamic_tool": {
      const name = str(item.toolName) || item.title || "tool";
      const summary = summarizeInput(item.input);
      return { prefix: icon(item), text: summary ? `${name} ${summary}` : String(name), style: stepStyle(item) };
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : [];
      const describe = (name: unknown, add: unknown, del: unknown) =>
        `${str(name) || "file"}${typeof add === "number" ? ` +${add}` : ""}${typeof del === "number" ? ` −${del}` : ""}`;
      const label =
        typeof item.fileName === "string" || changes.length === 0
          ? describe(item.fileName, item.additions, item.deletions)
          : changes.map((c) => describe(c.fileName ?? c.path, c.additions, c.deletions)).join(", ");
      return { prefix: "✎ ", text: label, style: stepStyle(item) };
    }
    case "file_search": {
      const count = Array.isArray(item.results) ? ` (${item.results.length} results)` : "";
      return { prefix: "⌕ ", text: `${str(item.pattern)}${count}`, style: "tool" };
    }
    case "web_search": {
      const patterns = Array.isArray(item.patterns) ? item.patterns.map(str).join(", ") : str(item.patterns);
      return { prefix: "⌕ ", text: `web: ${patterns}`, style: "tool" };
    }
    case "subagent":
      return { prefix: icon(item), text: `Subagent: ${oneLine(sanitize(str(item.prompt)), 200)}`, style: stepStyle(item) };
    case "compaction":
      return { prefix: "⋯ ", text: "Context compacted", style: "dim" };
    case "handoff":
      return { prefix: "⇄ ", text: `Handoff → ${str(item.toModel) || str(item.toProviderInstanceId)}`, style: "dim" };
    default: {
      const message = str(item.message ?? item.title ?? item.text) || item.type;
      return { prefix: "• ", text: oneLine(sanitize(message), 300), style: "dim" };
    }
  }
}

/** Everything known about a step, shown when the user expands it. */
export function stepDetail(item: TurnItem): Block[] {
  const summary = stepSummary(item);
  const outputBlocks = (output: unknown): Block[] => {
    if (typeof output !== "string" || !output.trim()) return [];
    const { lines, dropped } = tail(output, DETAIL_TAIL_LINES);
    const blocks: Block[] = dropped > 0 ? [{ prefix: "│ ", text: `… ${dropped} earlier lines`, style: "dim" }] : [];
    for (const line of lines) blocks.push({ prefix: "│ ", text: line, style: "dim" });
    return blocks;
  };
  switch (item.type) {
    case "reasoning":
      return [{ prefix: "∴ ", text: clip(sanitize(str(item.text)), MAX_TEXT_CHARS) + (item.streaming ? " ▍" : ""), style: "reasoning" }];
    case "command_execution":
      return [
        { ...summary, text: `$ ${clip(sanitize(str(item.input)), 4000)}` },
        ...outputBlocks(item.output),
      ];
    case "dynamic_tool": {
      const input = typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? {}, null, 2);
      return [summary, { prefix: "  ", text: clip(sanitize(input), 4000), style: "dim" }, ...outputBlocks(item.output)];
    }
    case "file_change": {
      const diff = str(item.diffStr) || (item.newStr ? `${str(item.oldStr)}\n→\n${str(item.newStr)}` : "");
      return diff ? [summary, ...outputBlocks(diff)] : [summary];
    }
    case "subagent": {
      const result = str(item.result) || str(item.progress);
      return [
        summary,
        { prefix: "  ", text: clip(sanitize(str(item.prompt)), 4000), style: "dim" },
        ...(result ? [{ prefix: "→ ", text: clip(sanitize(result), 8000), style: "plain" as Style }] : []),
      ];
    }
    default:
      return [summary];
  }
}

const searchCache = new WeakMap<TurnItem, string>();

/**
 * Text a search should find in an item: exactly what the item shows once fully opened, so every
 * hit that is counted can also be shown (folded detail included, off-screen raw output not).
 */
export function itemSearchText(item: TurnItem): string {
  let text = searchCache.get(item);
  if (text === undefined) {
    text = MARKDOWN_TYPES.has(item.type)
      ? messageRows(item, 10_000).map((r) => r.text).join("\n")
      : item.type === "reasoning"
      ? reasoningRows(item, 10_000).map((r) => r.text).join("\n")
      : (isMessage(item) ? messageBlocks(item) : stepDetail(item)).map((b) => `${b.prefix}${b.text}`).join("\n");
    searchCache.set(item, text);
  }
  return text;
}

const MARKDOWN_TYPES = new Set(["assistant_message", "proposed_plan"]);

const markdownRows = (source: string, width: number, pad = ""): Row[] =>
  renderMarkdown(source, width - textWidth(pad)).map((parts) => {
    const spans: Span[] = pad ? [[pad, "assistant"], ...parts] : parts;
    return { text: spans.map((s) => s[0]).join(""), style: "assistant", parts: spans };
  });

/** Opened thinking: Markdown in the dimmed thinking style, "∴ " on the first row. */
export function reasoningRows(item: TurnItem, width: number, pad = ""): Row[] {
  const lead = textWidth(pad) + 2;
  const lines = renderMarkdown(clip(sanitize(str(item.text)).trim(), MAX_TEXT_CHARS) || "Thinking…", width - lead);
  const rows = lines.map((parts, i): Row => {
    const spans: Span[] = [
      [`${pad}${i === 0 ? "∴ " : "  "}`, "reasoning"],
      ...parts.map(([t, s]): Span => [t, s === "assistant" ? "reasoning" : `${s}+reasoning`]),
    ];
    return { text: spans.map((s) => s[0]).join(""), style: "reasoning", parts: spans };
  });
  if (item.streaming && rows.length > 0) {
    const last = rows[rows.length - 1];
    rows[rows.length - 1] = { ...last, text: `${last.text} ▍`, parts: [...(last.parts ?? []), [" ▍", "reasoning"]] };
  }
  return rows;
}

/** Rows for a conversation-level item; agent replies and plans are rendered as Markdown. */
export function messageRows(item: TurnItem, width: number): Row[] {
  if (item.type === "assistant_message") {
    const rows = markdownRows(clip(sanitize(str(item.text)).trim(), MAX_TEXT_CHARS), width);
    if (!item.streaming) return rows;
    const last = rows[rows.length - 1];
    if (!last) return [{ text: "… ▍", style: "assistant" }];
    rows[rows.length - 1] = { ...last, text: `${last.text} ▍`, parts: [...(last.parts ?? []), [" ▍", "assistant"]] };
    return rows;
  }
  if (item.type === "proposed_plan") {
    return [
      { text: `☰ Proposed plan${item.streaming ? " ▍" : ""}`, style: "tool" },
      ...markdownRows(clip(sanitize(str(item.markdown)), MAX_TEXT_CHARS), width, "  "),
    ];
  }
  return layoutBlocks(messageBlocks(item), width);
}

export function layoutBlocks(blocks: Block[], width: number): Row[] {
  const rows: Row[] = [];
  for (const block of blocks) {
    const indent = textWidth(block.prefix);
    const cont = block.cont ?? " ".repeat(indent);
    const wrapped = wrapText(block.text, Math.max(4, width - indent));
    wrapped.forEach((line, i) => rows.push({ text: (i === 0 ? block.prefix : cont) + line, style: block.style }));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Status, activity, providers

export function providerLabel(instanceId: string | undefined, providers?: Map<string, ProviderStatus>): string {
  if (!instanceId) return "Agent";
  if (instanceId === "claudeAgent") return "Claude";
  if (instanceId === "codex") return "Codex";
  return providers?.get(instanceId)?.displayName ?? instanceId;
}

const RESTING_STATUSES = ["idle", "completed", "failed", "cancelled", "interrupted"];

export const isActiveStatus = (status: string | undefined): boolean => !RESTING_STATUSES.includes(status ?? "idle");

export function threadStatus(thread: ShellThread | undefined): { label: string; tone: Tone } {
  if (!thread) return { label: "Unknown", tone: "dim" };
  if (thread.deletedAt) return { label: "Deleted", tone: "bad" };
  if (thread.pendingRuntimeRequest) return { label: "Waiting for you", tone: "warn" };
  const status = thread.status ?? "idle";
  switch (status) {
    case "idle":
    case "completed":
      return { label: "Idle", tone: "dim" };
    case "failed":
      return { label: "Failed", tone: "bad" };
    case "cancelled":
    case "interrupted":
      return { label: "Interrupted", tone: "warn" };
    default:
      return { label: status === "running" ? "Running" : status.charAt(0).toUpperCase() + status.slice(1), tone: "good" };
  }
}

/** What the agent is doing right now, derived from the newest turn items. */
export function threadActivity(state: ThreadState, thread: ShellThread | undefined): { label: string; tone: Tone } {
  if (state.error && !state.loaded) return { label: "Error", tone: "bad" };
  if (!state.loaded) return { label: "Loading", tone: "dim" };
  if (thread?.pendingRuntimeRequest) return { label: "Waiting for approval/input", tone: "warn" };
  const items = state.sorted();
  for (let i = items.length - 1; i >= Math.max(0, items.length - 40); i--) {
    const item = items[i];
    if (!isLive(item)) continue;
    switch (item.type) {
      case "assistant_message":
        return { label: "Streaming", tone: "good" };
      case "reasoning":
        return { label: "Thinking", tone: "info" };
      case "command_execution":
        return { label: `Running: ${oneLine(sanitize(str(item.input)), 80) || "command"}`, tone: "warn" };
      case "dynamic_tool":
        return { label: `Tool: ${str(item.toolName) || "tool"}`, tone: "warn" };
      case "subagent":
        return { label: "Subagent working", tone: "info" };
      case "approval_request":
      case "user_input_request":
        return { label: "Waiting for approval/input", tone: "warn" };
      default:
        break;
    }
  }
  if (isActiveStatus(thread?.status)) return { label: "Working", tone: "good" };
  if (thread?.status === "failed") return { label: "Failed", tone: "bad" };
  return { label: "Waiting", tone: "dim" };
}

// ---------------------------------------------------------------------------
// Time & usage

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

export function formatAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const ms = now - at;
  return ms < 60_000 ? "just now" : `${formatDuration(ms)} ago`;
}

/** "active now" while a run is active, otherwise how long ago the last run finished or started. */
export function lastActive(thread: ShellThread, now = Date.now()): string {
  if (isActiveStatus(thread.status)) return "active now";
  return formatAgo(thread.latestRunCompletedAt ?? thread.latestRunStartedAt ?? thread.updatedAt, now);
}

export function formatResetClock(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const hhmm = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (at.getTime() - now < 20 * 3_600_000 && at.getDate() === new Date(now).getDate()) return hhmm;
  return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${hhmm}`;
}

export function usageBar(percent: number, width: number): string {
  const cells = Math.max(1, width);
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = Math.round((clamped / 100) * cells);
  return "█".repeat(filled) + "░".repeat(cells - filled);
}

export function usageTone(percent: number): Tone {
  if (percent >= 90) return "bad";
  if (percent >= 70) return "warn";
  return "good";
}

export interface UsageLine {
  parts: Array<[string, Style | Tone | "header" | "claude" | "codex"]>;
}

/** Lines for one provider in the usage column (Claude's /usage, Codex's /status equivalent). */
export function usageLines(
  instanceId: "claudeAgent" | "codex",
  provider: ProviderStatus | undefined,
  width: number,
  now = Date.now(),
): UsageLine[] {
  const name = instanceId === "claudeAgent" ? "Claude" : "Codex";
  const color = instanceId === "claudeAgent" ? "claude" : "codex";
  const lines: UsageLine[] = [];
  const plan = provider?.auth?.label?.replace(/\s*Subscription$/i, "");
  lines.push({ parts: [[name, color], [plan ? ` · ${plan}` : "", "dim"]] });
  if (!provider) {
    lines.push({ parts: [["Not reported by T3", "dim"]] });
    return lines;
  }
  if (provider.enabled === false || provider.status === "disabled") {
    lines.push({ parts: [["Disabled in T3", "dim"]] });
    return lines;
  }
  const limits = provider.usageLimits;
  if (!limits || (limits.windows.length === 0 && !limits.unavailable)) {
    lines.push({ parts: [["No usage data yet", "dim"]] });
    return lines;
  }
  if (limits.unavailable) {
    lines.push({ parts: [[limits.unavailable.message ?? `Usage ${limits.unavailable.reason}`, "warn"]] });
  }
  for (const window of limits.windows) lines.push(...windowLines(window, width, now));
  if (limits.resetCredits && limits.resetCredits.availableCount > 0) {
    const n = limits.resetCredits.availableCount;
    lines.push({ parts: [[`${n} reset credit${n === 1 ? "" : "s"} available`, "info"]] });
  }
  if (limits.checkedAt) lines.push({ parts: [[`checked ${formatAgo(limits.checkedAt, now)}`, "dim"]] });
  return lines;
}

function windowLines(window: UsageWindow, width: number, now: number): UsageLine[] {
  const pct = Math.round(window.usedPercent);
  const pctText = `${pct}%`;
  const labelWidth = Math.max(1, width - pctText.length - 1);
  const label = window.label.length > labelWidth ? `${window.label.slice(0, labelWidth - 1)}…` : window.label;
  const lines: UsageLine[] = [
    { parts: [[label, "plain"], [" ".repeat(Math.max(1, width - textWidth(label) - pctText.length)), "plain"], [pctText, usageTone(pct)]] },
    { parts: [[usageBar(pct, width), usageTone(pct)]] },
  ];
  if (window.resetsAt) {
    const ms = Date.parse(window.resetsAt) - now;
    lines.push({ parts: [[`resets in ${formatDuration(ms)} · ${formatResetClock(window.resetsAt, now)}`, "dim"]] });
  }
  return lines;
}
