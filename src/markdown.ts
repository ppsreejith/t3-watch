import { Lexer, type Token, type Tokens } from "marked";
import { textWidth, wrapParts, type Span } from "./text.js";

/** One rendered row as styled spans. */
export type Line = Span[];

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const decode = (text: string): string => text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity]);

/** Combined paint key for nested styles, e.g. "strong+link". Plain text paints as "assistant". */
const styleKey = (styles: string[]): string => (styles.length > 0 ? styles.join("+") : "assistant");

const spansWidth = (spans: Span[]): number => textWidth(spans.map((s) => s[0]).join(""));

function inline(tokens: Token[] | undefined, styles: string[]): Span[] {
  const out: Span[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text":
      case "escape": {
        const nested = (token as Tokens.Text).tokens;
        if (nested && nested.length > 0) out.push(...inline(nested, styles));
        // A single newline inside a paragraph is a soft break: it reads as a space.
        else out.push([decode(token.text).replace(/\n/g, " "), styleKey(styles)]);
        break;
      }
      case "strong":
      case "em":
      case "del":
      case "link":
        out.push(...inline((token as Tokens.Strong).tokens, [...styles, token.type]));
        break;
      case "codespan":
        out.push([decode(token.text), styleKey([...styles, "code"])]);
        break;
      case "br":
        out.push(["\n", styleKey(styles)]);
        break;
      case "image":
        out.push([`[image: ${token.text || token.href}]`, styleKey([...styles, "dim"])]);
        break;
      default:
        if ("text" in token && typeof token.text === "string") out.push([decode(token.text), styleKey(styles)]);
    }
  }
  return out;
}

const prefix = (lines: Line[], first: Span, rest: Span): Line[] =>
  (lines.length > 0 ? lines : [[]]).map((line, i) => [i === 0 ? first : rest, ...line]);

function codeBlock(token: Tokens.Code, width: number): Line[] {
  const inner = Math.max(4, width - 2);
  const lines: Line[] = [];
  for (const source of token.text.split("\n")) {
    for (const wrapped of wrapParts([[source || " ", "codeBlock"]], inner)) {
      const line: Line = [[" ", "codeBlock"], ...wrapped];
      const pad = width - spansWidth(line);
      if (pad > 0) line.push([" ".repeat(pad), "codeBlock"]);
      lines.push(line);
    }
  }
  return lines;
}

function table(token: Tokens.Table, width: number): Line[] {
  const header = token.header.map((cell) => inline(cell.tokens, ["th"]));
  const rows = token.rows.map((row) => row.map((cell) => inline(cell.tokens, [])));
  const widths = header.map((cell, c) => Math.max(1, spansWidth(cell), ...rows.map((row) => (row[c] ? spansWidth(row[c]) : 0))));
  const fits = widths.reduce((sum, w) => sum + w, 0) + 3 * (widths.length - 1) <= width;
  if (fits) {
    const line = (cells: Span[][]): Line => {
      const out: Line = [];
      widths.forEach((w, c) => {
        if (c > 0) out.push([" │ ", "tableBorder"]);
        const cell = cells[c] ?? [];
        out.push(...cell);
        if (w - spansWidth(cell) > 0) out.push([" ".repeat(w - spansWidth(cell)), "assistant"]);
      });
      return out;
    };
    return [line(header), [[widths.map((w) => "─".repeat(w)).join("─┼─"), "tableBorder"]], ...rows.map(line)];
  }
  // Too wide for the column: one block per row, "Header: value" per cell.
  const out: Line[] = [];
  rows.forEach((row, r) => {
    if (r > 0) out.push([]);
    row.forEach((cell, c) => out.push(...wrapParts([...(header[c] ?? []), [": ", "th"], ...cell], width)));
  });
  return out;
}

function block(token: Token, width: number): Line[] {
  switch (token.type) {
    case "heading":
      return wrapParts(inline(token.tokens, [`h${Math.min((token as Tokens.Heading).depth, 3)}`]), width);
    case "paragraph":
      return wrapParts(inline(token.tokens, []), width);
    case "text": {
      const text = token as Tokens.Text;
      return wrapParts(text.tokens ? inline(text.tokens, []) : [[decode(text.text), "assistant"]], width);
    }
    case "code":
      return codeBlock(token as Tokens.Code, width);
    case "blockquote": {
      const inner = blocks((token as Tokens.Blockquote).tokens, width - 2).map((line) =>
        line.map(([text, style]): Span => [text, style === "assistant" ? "quote" : `${style}+quote`]),
      );
      return prefix(inner, ["│ ", "quote"], ["│ ", "quote"]);
    }
    case "list": {
      const list = token as Tokens.List;
      const lines: Line[] = [];
      list.items.forEach((item, i) => {
        const marker = item.task ? (item.checked ? "☑ " : "☐ ") : list.ordered ? `${Number(list.start || 1) + i}. ` : "• ";
        const indent = textWidth(marker);
        if (list.loose && i > 0) lines.push([]);
        lines.push(...prefix(blocks(item.tokens, width - indent, !list.loose), [marker, "bullet"], [" ".repeat(indent), "assistant"]));
      });
      return lines;
    }
    case "table":
      return table(token as Tokens.Table, width);
    case "hr":
      return [[["─".repeat(Math.max(1, width)), "rule"]]];
    case "html":
      return wrapParts([[(token as Tokens.HTML).text.trim(), "dim"]], width);
    case "space":
    case "checkbox":
      return [];
    default:
      return "text" in token && typeof token.text === "string" && token.text ? wrapParts([[token.text, "assistant"]], width) : [];
  }
}

/** Renders block tokens; `tight` (tight list items) skips the blank line between blocks. */
function blocks(tokens: Token[], width: number, tight = false): Line[] {
  const out: Line[] = [];
  for (const token of tokens) {
    const lines = block(token, width);
    if (lines.length === 0) continue;
    if (out.length > 0 && !tight) out.push([]);
    out.push(...lines);
  }
  return out;
}

/**
 * Renders Markdown into styled rows no wider than `width`. Unfinished syntax while a reply is
 * still streaming (an open `**` or code fence) simply shows as text until it completes.
 */
export function renderMarkdown(source: string, width: number): Line[] {
  const w = Math.max(8, width);
  try {
    return blocks(Lexer.lex(source, { gfm: true }), w);
  } catch {
    return wrapParts([[source, "assistant"]], w);
  }
}
