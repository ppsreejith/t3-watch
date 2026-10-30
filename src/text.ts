import stringWidth from "string-width";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
// CSI, OSC and two-byte escape sequences.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Makes agent/tool output safe to paint: no escapes, no control characters, tabs expanded. */
export function sanitize(input: string): string {
  let text = input.replace(ANSI, "").replace(/\r\n/g, "\n");
  if (text.includes("\r")) {
    // Progress bars redraw with bare CRs; keep what the terminal would finally show.
    text = text
      .split("\n")
      .map((line) => line.slice(line.lastIndexOf("\r") + 1))
      .join("\n");
  }
  return text.replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function graphemeWidth(grapheme: string): number {
  if (grapheme.length === 1) {
    const code = grapheme.charCodeAt(0);
    if (code >= 0x20 && code < 0x7f) return 1;
  }
  return stringWidth(grapheme);
}

export function textWidth(text: string): number {
  return PRINTABLE_ASCII.test(text) ? text.length : stringWidth(text);
}

/** Word-wraps to `width` terminal cells, hard-breaking words that do not fit. */
export function wrapText(text: string, width: number): string[] {
  const max = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length <= max && PRINTABLE_ASCII.test(paragraph)) {
      rows.push(paragraph);
      continue;
    }
    let line = "";
    let lineWidth = 0;
    let breakAt = -1;
    let breakWidth = 0;
    for (const { segment } of segmenter.segment(paragraph)) {
      const w = graphemeWidth(segment);
      if (lineWidth + w > max && lineWidth > 0) {
        if (segment === " ") {
          rows.push(line);
          line = "";
          lineWidth = 0;
          breakAt = -1;
          continue;
        }
        if (breakAt > 0) {
          rows.push(line.slice(0, breakAt).trimEnd());
          line = line.slice(breakAt);
          lineWidth -= breakWidth;
        } else {
          rows.push(line);
          line = "";
          lineWidth = 0;
        }
        breakAt = -1;
        if (lineWidth + w > max && lineWidth > 0) {
          rows.push(line);
          line = "";
          lineWidth = 0;
        }
      }
      line += segment;
      lineWidth += w;
      if (segment === " ") {
        breakAt = line.length;
        breakWidth = lineWidth;
      }
    }
    rows.push(line);
  }
  return rows;
}

/** Truncates with an ellipsis and pads so the result is exactly `width` cells. */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const w = textWidth(text);
  if (w <= width) return text + " ".repeat(width - w);
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const gw = graphemeWidth(segment);
    if (used + gw > width - 1) break;
    out += segment;
    used += gw;
  }
  return out + "…" + " ".repeat(Math.max(0, width - used - 1));
}

export function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (${text.length - maxChars} more characters)` : text;
}
