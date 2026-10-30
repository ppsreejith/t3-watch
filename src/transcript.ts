import {
  isLive,
  isMessage,
  isVisible,
  itemSearchText,
  layoutBlocks,
  messageBlocks,
  stepDetail,
  stepFailed,
  stepKind,
  stepSummary,
  type Block,
  type Row,
} from "./format.js";
import type { TurnItem } from "./protocol.js";
import type { ThreadState } from "./store.js";

/**
 * A focusable piece of a conversation: a message, a folded run of steps (thinking and tool
 * calls between two messages), or one step of an opened run.
 */
export interface Entry {
  key: string;
  kind: "message" | "group" | "step";
  item?: TurnItem;
  steps?: TurnItem[];
}

export interface LayoutRow extends Row {
  /** Index into `entries`, or -1 for spacing and notes. */
  entry: number;
}

export interface Layout {
  rows: LayoutRow[];
  entries: Entry[];
  start: number[];
  end: number[];
  index: Map<string, number>;
  /** Step item id → key of the group it is folded into. */
  owner: Map<string, string>;
}

/** Splits items into messages and runs of steps; a lone step stands on its own. */
export function structure(items: TurnItem[]): Entry[] {
  const out: Entry[] = [];
  let run: TurnItem[] = [];
  const flush = () => {
    if (run.length === 1) out.push({ key: run[0].id, kind: "step", item: run[0] });
    else if (run.length > 1) out.push({ key: `group:${run[0].id}`, kind: "group", steps: run });
    run = [];
  };
  for (const item of items) {
    if (!isVisible(item)) continue;
    if (isMessage(item)) {
      flush();
      out.push({ key: item.id, kind: "message", item });
    } else {
      run.push(item);
    }
  }
  flush();
  return out;
}

const COLLAPSED_MESSAGE_ROWS = 3;

const signature = (item: TurnItem): string =>
  `${item.updatedAt ?? ""}|${item.status ?? ""}|${item.streaming ? 1 : 0}|${typeof item.text === "string" ? item.text.length : -1}|${typeof item.output === "string" ? item.output.length : -1}`;

const indent = (blocks: Block[]): Block[] =>
  blocks.map((b) => ({ ...b, prefix: `  ${b.prefix}`, cont: `  ${b.cont ?? " ".repeat(b.prefix.length)}` }));

const summaryRow = (item: TurnItem, pad = ""): Row => {
  const b = stepSummary(item);
  return { text: `${pad}${b.prefix}${b.text}`, style: b.style };
};

/** Fold state and cached layout for one conversation column. */
export class Transcript {
  /** Keys whose state differs from the default (messages open, groups and steps folded). */
  private readonly flipped = new Set<string>();
  private generation = 0;
  private readonly rowCache = new Map<string, { sig: string; rows: Row[] }>();
  private cached: { key: string; layout: Layout } | undefined;

  isExpanded(entry: Pick<Entry, "key" | "kind">): boolean {
    return entry.kind === "message" ? !this.flipped.has(entry.key) : this.flipped.has(entry.key);
  }

  /** Returns true when the state changed. */
  setExpanded(entry: Pick<Entry, "key" | "kind">, expanded: boolean): boolean {
    if (this.isExpanded(entry) === expanded) return false;
    this.flip(entry.key);
    return true;
  }

  toggle(entry: Pick<Entry, "key" | "kind">): void {
    this.flip(entry.key);
  }

  flip(key: string): void {
    if (this.flipped.has(key)) this.flipped.delete(key);
    else this.flipped.add(key);
    this.generation++;
  }

  /** Opens or folds every step group; resets messages and steps to their defaults. */
  setAllGroups(state: ThreadState, expanded: boolean): void {
    this.flipped.clear();
    if (expanded) for (const entry of structure(state.sorted())) if (entry.kind === "group") this.flipped.add(entry.key);
    this.generation++;
  }

  layout(state: ThreadState, width: number): Layout {
    const key = `${state.version}|${width}|${this.generation}`;
    if (this.cached?.key === key) return this.cached.layout;
    const layout: Layout = { rows: [], entries: [], start: [], end: [], index: new Map(), owner: new Map() };
    const note = (text: string, style: Row["style"]) => layout.rows.push({ text, style, entry: -1 });
    const add = (entry: Entry, rows: Row[]) => {
      const i = layout.entries.length;
      layout.entries.push(entry);
      layout.index.set(entry.key, i);
      layout.start.push(layout.rows.length);
      for (const row of rows) layout.rows.push({ ...row, entry: i });
      layout.end.push(layout.rows.length);
    };

    if (state.hasMoreHistory) note("… earlier history not loaded", "dim");
    if (!state.loaded) note(state.error ? `✗ ${state.error}` : "Loading…", state.error ? "error" : "dim");
    const seen = new Set<string>();
    structure(state.sorted()).forEach((entry, n) => {
      if (n > 0) note("", "plain");
      if (entry.kind === "message") {
        add(entry, this.messageRows(entry.item!, width, seen));
      } else if (entry.kind === "step") {
        add(entry, this.stepRows(entry.item!, width, "", seen));
      } else {
        const expanded = this.isExpanded(entry);
        for (const step of entry.steps!) layout.owner.set(step.id, entry.key);
        add(entry, groupRows(entry.steps!, expanded));
        if (expanded) for (const step of entry.steps!) add({ key: step.id, kind: "step", item: step }, this.stepRows(step, width, "  ", seen));
      }
    });
    for (const cachedKey of this.rowCache.keys()) if (!seen.has(cachedKey)) this.rowCache.delete(cachedKey);
    if (state.loaded && layout.entries.length === 0) note("No messages yet.", "dim");
    this.cached = { key, layout };
    return layout;
  }

  private messageRows(item: TurnItem, width: number, seen: Set<string>): Row[] {
    const expanded = this.isExpanded({ key: item.id, kind: "message" });
    const rows = this.cachedRows(item, `${width}|${expanded}`, seen, () => layoutBlocks(messageBlocks(item), width));
    if (expanded || rows.length <= COLLAPSED_MESSAGE_ROWS + 1) return rows;
    return [...rows.slice(0, COLLAPSED_MESSAGE_ROWS), { text: `  … ${rows.length - COLLAPSED_MESSAGE_ROWS} more lines`, style: "dim" }];
  }

  private stepRows(item: TurnItem, width: number, pad: string, seen: Set<string>): Row[] {
    const expanded = this.isExpanded({ key: item.id, kind: "step" });
    if (!expanded) return this.cachedRows(item, `${pad}|summary`, seen, () => [summaryRow(item, pad)]);
    return this.cachedRows(item, `${width}|${pad}|detail`, seen, () =>
      layoutBlocks(pad ? indent(stepDetail(item)) : stepDetail(item), width),
    );
  }

  private cachedRows(item: TurnItem, variant: string, seen: Set<string>, build: () => Row[]): Row[] {
    const cacheKey = `${item.id}|${variant}`;
    seen.add(cacheKey);
    const sig = signature(item);
    const hit = this.rowCache.get(cacheKey);
    if (hit && hit.sig === sig) return hit.rows;
    const rows = build();
    this.rowCache.set(cacheKey, { sig, rows });
    return rows;
  }
}

/** Header of a run of steps, plus the live step while it is folded. */
function groupRows(steps: TurnItem[], expanded: boolean): Row[] {
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(stepKind(step), (counts.get(stepKind(step)) ?? 0) + 1);
  const kinds = [...counts].sort((a, b) => b[1] - a[1]).map(([kind, n]) => (n > 1 ? `${kind} ×${n}` : kind));
  const failed = steps.filter(stepFailed).length;
  const live = steps.filter(isLive);
  const text = `${expanded ? "▾" : "▸"} ${steps.length} steps · ${kinds.join(" · ")}${failed ? ` · ${failed} failed` : ""}`;
  const rows: Row[] = [{ text, style: live.length ? "toolRun" : failed ? "toolErr" : "dim" }];
  if (!expanded && live.length) rows.push(summaryRow(live[live.length - 1], "  "));
  return rows;
}

// ---------------------------------------------------------------------------
// Focus navigation (pure: the caller owns `top` and the focused key)

export const maxTop = (layout: Layout, height: number): number => Math.max(0, layout.rows.length - height);

/** Focused entry index; unknown keys fall back to their folded group, then to the last entry. */
export function focusIndex(layout: Layout, key: string | undefined): number {
  if (layout.entries.length === 0) return -1;
  if (key !== undefined) {
    const direct = layout.index.get(key);
    if (direct !== undefined) return direct;
    const owner = layout.owner.get(key);
    const viaOwner = owner === undefined ? undefined : layout.index.get(owner);
    if (viaOwner !== undefined) return viaOwner;
  }
  return layout.entries.length - 1;
}

/** Scroll offset that shows entry `i`; tall entries show their start (or end when moving up). */
export function reveal(layout: Layout, i: number, top: number, height: number, fromBottom = false): number {
  const start = layout.start[i];
  const end = layout.end[i];
  let next = top;
  if (start >= top && end <= top + height) next = top;
  else if (end - start >= height) next = fromBottom ? end - height : start;
  else if (start < top) next = start;
  else next = end - height;
  return Math.min(Math.max(0, next), maxTop(layout, height));
}

/** ↑/↓: scroll through a tall entry line by line, otherwise move focus to the neighbour. */
export function moveFocus(layout: Layout, i: number, top: number, height: number, dir: 1 | -1): { focus: number; top: number } {
  const limit = maxTop(layout, height);
  if (i < 0) return { focus: i, top: Math.min(Math.max(0, top + dir), limit) };
  const start = layout.start[i];
  const end = layout.end[i];
  if (dir > 0) {
    if (end > top + height) return { focus: i, top: Math.min(top + 1, limit) };
    if (i < layout.entries.length - 1) return { focus: i + 1, top: reveal(layout, i + 1, top, height) };
    return { focus: i, top: Math.min(top + 1, limit) };
  }
  if (start < top) return { focus: i, top: top - 1 };
  if (i > 0) return { focus: i - 1, top: reveal(layout, i - 1, top, height, true) };
  return { focus: i, top: Math.max(0, top - 1) };
}

/** First entry visible at or below row `top`. */
export function entryAt(layout: Layout, top: number): number {
  for (let i = 0; i < layout.entries.length; i++) if (layout.end[i] > top) return i;
  return layout.entries.length - 1;
}

// ---------------------------------------------------------------------------
// Search

export interface SearchQuery {
  text: string;
  caseSensitive: boolean;
}

/** Smart case: lower-case queries ignore case, any capital letter makes the search exact. */
export const makeQuery = (text: string): SearchQuery => ({ text, caseSensitive: /[A-Z]/.test(text) });

export function contains(query: SearchQuery, haystack: string): boolean {
  if (!query.text) return false;
  return query.caseSensitive ? haystack.includes(query.text) : haystack.toLowerCase().includes(query.text.toLowerCase());
}

/** Matching items, oldest first. */
export function findMatches(state: ThreadState, query: SearchQuery): TurnItem[] {
  if (!query.text) return [];
  return state.sorted().filter((item) => isVisible(item) && contains(query, itemSearchText(item)));
}

export type Revealed = Array<Pick<Entry, "key" | "kind">>;

/**
 * Unfolds whatever hides `item` (its group, a folded message, a step's one-line summary, which
 * may cut hits off at the column edge). Returns what it opened so `foldBack` can close it again.
 */
export function revealItem(transcript: Transcript, state: ThreadState, item: TurnItem, query: SearchQuery): Revealed {
  const opened: Revealed = [];
  const open = (entry: Pick<Entry, "key" | "kind">) => {
    if (transcript.setExpanded(entry, true)) opened.push({ key: entry.key, kind: entry.kind });
  };
  if (isMessage(item)) {
    open({ key: item.id, kind: "message" });
    return opened;
  }
  const group = structure(state.sorted()).find((e) => e.kind === "group" && e.steps!.some((s) => s.id === item.id));
  if (group) open(group);
  open({ key: item.id, kind: "step" });
  return opened;
}

/** Folds what `revealItem` opened, leaving anything the user changed since alone. */
export function foldBack(transcript: Transcript, revealed: Revealed): void {
  for (const entry of revealed) transcript.setExpanded(entry, false);
}

/** A visible hit: layout row and character offset in that row's text. */
export interface Occurrence {
  row: number;
  at: number;
}

/** Character offsets of every hit in `text`, matched the same way the highlighter paints them. */
export function hitOffsets(text: string, query: SearchQuery): number[] {
  if (!query.text) return [];
  const haystack = query.caseSensitive ? text : text.toLowerCase();
  // Lower-casing changed the length (rare Unicode): offsets would be wrong, so report none.
  if (haystack.length !== text.length) return [];
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
  const offsets: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) offsets.push(at);
  return offsets;
}

/** Every visible hit inside entry `i`, top to bottom. */
export function occurrences(layout: Layout, i: number, query: SearchQuery): Occurrence[] {
  if (i < 0 || i >= layout.entries.length) return [];
  const out: Occurrence[] = [];
  for (let row = layout.start[i]; row < layout.end[i]; row++) {
    for (const at of hitOffsets(layout.rows[row].text, query)) out.push({ row, at });
  }
  return out;
}

/** Number of hits in an item's searchable text; used for the n/total counter. */
export function countHits(item: TurnItem, query: SearchQuery): number {
  return Math.max(1, hitOffsets(itemSearchText(item), query).length);
}
