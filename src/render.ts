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
  // Markdown
  h1: `\x1b[1;4m${fg(183)}`,
  h2: `\x1b[1m${fg(183)}`,
  h3: `\x1b[1m${fg(146)}`,
  strong: "\x1b[1m",
  em: "\x1b[3m",
  del: "\x1b[9m",
  code: `${fg(180)}\x1b[48;5;236m`,
  codeBlock: `${fg(252)}\x1b[48;5;235m`,
  link: `\x1b[4m${fg(75)}`,
  bullet: fg(75),
  quote: fg(246),
  rule: fg(240),
  th: "\x1b[1m",
  tableBorder: fg(240),
};

/** Paints `text`; a "+"-joined key (nested Markdown such as "strong+link") combines styles. */
export const paint = (text: string, key: string): string => {
  const code = key.includes("+") ? key.split("+").map((k) => PAINT[k] ?? "").join("") : PAINT[key];
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

/**
 * Overlays search hits on a row's styled parts; the hit starting at `currentAt` (an offset into
 * the row's text) is painted as the active one. Hits may span several parts.
 */
export function highlight(parts: Part[], query: SearchQuery | undefined, currentAt = -1): Part[] {
  if (!query?.text) return parts;
  const text = parts.map((p) => p[0]).join("");
  const hits = hitOffsets(text, query);
  if (hits.length === 0) return parts;
  const styleAt = (offset: number): string | undefined => {
    for (const at of hits) if (offset >= at && offset < at + query.text.length) return at === currentAt ? "matchCurrent" : "match";
    return undefined;
  };
  const out: Part[] = [];
  let offset = 0;
  for (const [partText, partStyle] of parts) {
    // Split each part at hit boundaries, then merge neighbours with the same style.
    for (const char of partText) {
      const style = styleAt(offset) ?? partStyle;
      const last = out[out.length - 1];
      if (last && last[1] === style) last[0] += char;
      else out.push([char, style]);
      offset += char.length;
    }
  }
  return out;
}
