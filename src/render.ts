import { hitOffsets, type SearchQuery } from "./transcript.js";
import { fit, textWidth } from "./text.js";

export type Part = [text: string, paint: string];

export const RESET = "\x1b[0m";
const fg = (n: number) => `\x1b[38;5;${n}m`;

/** Paint names used by rows (format.ts styles), tones and chrome. */
export const PAINT: Record<string, string> = {
  plain: "",
  assistant: "",
  user: `\x1b[1m${fg(117)}`,
  reasoning: `\x1b[2;3m`,
  tool: fg(109),
  toolRun: fg(221),
  toolErr: fg(203),
  dim: fg(245),
  warn: fg(214),
  error: fg(203),
  good: fg(78),
  bad: fg(203),
  info: fg(75),
  header: "\x1b[1m",
  claude: `\x1b[1m${fg(209)}`,
  codex: `\x1b[1m${fg(80)}`,
  border: fg(240),
  selected: `\x1b[1m${fg(231)}`,
  marker: `\x1b[1m${fg(75)}`,
  // Every hit is yellow; the current one (what n/N step from) is bold white on red.
  match: `\x1b[30;48;5;221m`,
  matchCurrent: `\x1b[1;97;48;5;161m`,
  cursor: "\x1b[7m",
};

export const paint = (text: string, key: string): string => {
  const code = PAINT[key];
  return code && text ? `${code}${text}${RESET}` : text;
};

/** Paints parts into exactly `width` cells, truncating the overflow with an ellipsis. */
export function cell(parts: Part[], width: number): string {
  if (width <= 0) return "";
  const total = parts.reduce((n, [text]) => n + textWidth(text), 0);
  let out = "";
  if (total <= width) {
    for (const [text, key] of parts) out += paint(text, key);
    return out + " ".repeat(width - total);
  }
  let used = 0;
  for (const [text, key] of parts) {
    const w = textWidth(text);
    if (used + w <= width - 1) {
      out += paint(text, key);
      used += w;
      continue;
    }
    out += paint(fit(text, width - used), key);
    used = width;
    break;
  }
  return out + " ".repeat(Math.max(0, width - used));
}

/** One cell of left padding inside every pane. */
export const padded = (parts: Part[], width: number): string => (width <= 0 ? "" : ` ${cell(parts, width - 1)}`);

/** Splits a row so search hits are painted; the hit starting at `currentAt` is the active one. */
export function highlight(text: string, style: string, query: SearchQuery | undefined, currentAt = -1): Part[] {
  if (!query?.text) return [[text, style]];
  const offsets = hitOffsets(text, query);
  if (offsets.length === 0) return [[text, style]];
  const parts: Part[] = [];
  let from = 0;
  for (const at of offsets) {
    if (at > from) parts.push([text.slice(from, at), style]);
    parts.push([text.slice(at, at + query.text.length), at === currentAt ? "matchCurrent" : "match"]);
    from = at + query.text.length;
  }
  if (from < text.length) parts.push([text.slice(from), style]);
  return parts;
}
