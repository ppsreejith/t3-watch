import { METHODS, type ProviderStatus, type ServerConfigStreamItem, type ShellStreamItem, type ThreadStreamItem } from "./protocol.js";
import type { ConnectionState, RpcClient } from "./rpc.js";
import { ProvidersState, ShellState, ThreadState } from "./store.js";
import { label, lastActive, providerLabel, threadActivity, threadStatus, usageLines, type UsageLine } from "./format.js";
import { isSettled, isSubagent, listThreads, pickThreads, recentColumns, resolveThreadIds, shortId } from "./select.js";
import { ACTIVE_BACKGROUND, RESET, PAINT, cell, highlight, padded, paint, withBackground, type Part } from "./render.js";
import {
  Transcript,
  entryAt,
  countHits,
  findMatches,
  foldBack,
  focusIndex,
  makeQuery,
  maxTop,
  moveFocus,
  occurrences,
  reveal,
  revealItem,
  type Layout,
  type Revealed,
} from "./transcript.js";
import { textWidth } from "./text.js";

export type Selection = { mode: "recent"; count: number } | { mode: "all" } | { mode: "ids"; ids: string[] };

export interface DashboardOptions {
  selection: Selection;
  subagents: boolean;
  settled: boolean;
  follow: boolean;
  usage: boolean;
  select: boolean;
  endpointLabel(): string;
  serverVersion(): string | undefined;
}

interface Column {
  threadId: string;
  state: ThreadState;
  transcript: Transcript;
  /** First visible row, and whether the view follows new output. */
  top: number;
  stick: boolean;
  /** Focused entry key; undefined while following means "the last entry". */
  focusKey: string | undefined;
  /** Rows between the focused entry's start and `top`; keeps the view put as content above changes. */
  anchor: number;
  /** Body size from the last render, used by key handlers. */
  width: number;
  height: number;
}

interface Picker {
  cursor: number;
  top: number;
  chosen: string[];
  subagents: boolean;
  settled: boolean;
}

interface Search {
  column: Column;
  query: string;
  editing: boolean;
  origin: { focusKey: string | undefined; top: number; stick: boolean; anchor: number; ordinal: number };
  /** What was unfolded to show the current match; folded back when the match moves or is cleared. */
  revealed: Revealed;
  /** Item holding the active hit, and which of its visible hits (top to bottom) is active. */
  current: string | undefined;
  occurrence: number;
  position: number;
  total: number;
}

const MIN_COLUMN_WIDTH = 26;
const PROVIDER_PAINT = (id: string | undefined) => (id === "codex" ? "codex" : id === "claudeAgent" ? "claude" : "header");

type KeyName =
  | "up" | "down" | "left" | "right" | "shift-left" | "shift-right"
  | "pageup" | "pagedown" | "home" | "end" | "shift-tab" | "escape";

const ESCAPES: Array<[string, KeyName]> = [
  ["\x1b[A", "up"], ["\x1bOA", "up"], ["\x1b[B", "down"], ["\x1bOB", "down"],
  ["\x1b[C", "right"], ["\x1bOC", "right"], ["\x1b[D", "left"], ["\x1bOD", "left"],
  ["\x1b[5~", "pageup"], ["\x1b[6~", "pagedown"],
  ["\x1b[H", "home"], ["\x1b[1~", "home"], ["\x1bOH", "home"], ["\x1b[7~", "home"],
  ["\x1b[F", "end"], ["\x1b[4~", "end"], ["\x1bOF", "end"], ["\x1b[8~", "end"],
  ["\x1b[Z", "shift-tab"],
  // Shift+←/→ (xterm, iTerm2, Terminal.app, kitty).
  ["\x1b[1;2D", "shift-left"], ["\x1b[1;2C", "shift-right"], ["\x1b[2D", "shift-left"], ["\x1b[2C", "shift-right"],
];

/** Splits a raw stdin chunk into key names and printable characters. */
export function parseKeys(data: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] === "\x1b") {
      const match = ESCAPES.find(([seq]) => data.startsWith(seq, i));
      if (match) {
        keys.push(match[1]);
        i += match[0].length;
        continue;
      }
      if (data[i + 1] === "[" || data[i + 1] === "O") {
        // Unknown CSI/SS3 sequence: skip to its final byte.
        let j = i + 2;
        while (j < data.length && !/[@-~]/.test(data[j])) j++;
        i = j + 1;
        continue;
      }
      keys.push("escape");
      i += 1;
      continue;
    }
    const char = String.fromCodePoint(data.codePointAt(i) ?? 0);
    keys.push(char);
    i += char.length;
  }
  return keys;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export class Dashboard {
  private readonly shell = new ShellState();
  private readonly providers = new ProvidersState();
  private columns: Column[] = [];
  private selected = 0;
  private offset = 0;
  private mode: "dashboard" | "picker" = "dashboard";
  private picker: Picker | undefined;
  private search: Search | undefined;
  private selection: Selection;
  private usage: boolean;
  private initialized = false;
  private repick = false;
  private notice: { text: string; tone: string; at: number } | undefined;
  private previous: string[] = [];
  private renderTimer: NodeJS.Timeout | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  private lastRender = 0;
  private restored = false;

  constructor(
    private readonly client: RpcClient,
    private readonly options: DashboardOptions,
    private readonly stdin: NodeJS.ReadStream = process.stdin,
    private readonly stdout: NodeJS.WriteStream = process.stdout,
  ) {
    this.selection = options.selection;
    this.usage = options.usage;
  }

  start(): void {
    this.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J");
    this.stdin.setRawMode?.(true);
    this.stdin.setEncoding("utf8");
    this.stdin.resume();
    this.stdin.on("data", (data: string) => this.onInput(data));
    this.stdout.on("resize", () => {
      this.previous = [];
      this.stdout.write("\x1b[2J");
      this.render();
    });
    process.on("exit", () => this.restore());
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => this.quit(0));
    process.on("uncaughtException", (error) => {
      this.restore();
      process.stderr.write(`t3-watch crashed: ${error.stack ?? error}\n`);
      process.exit(1);
    });

    this.client.on("state", (state: ConnectionState) => {
      if (state.kind === "open" && this.selection.mode !== "ids" && this.options.follow) this.repick = true;
      this.scheduleRender();
    });
    this.client.on("warning", (text: string) => this.setNotice(text, "warn"));

    this.client.subscribe("shell", METHODS.subscribeShell, {}, {
      onValues: (values) => {
        for (const value of values) this.shell.apply(value as ShellStreamItem);
        this.onShellChanged();
        this.scheduleRender();
      },
      onExit: (failure) => failure && this.setNotice(`Thread list: ${failure}`, "bad"),
    });
    this.client.subscribe("config", METHODS.subscribeServerConfig, {}, {
      onValues: (values) => {
        for (const value of values) this.providers.apply(value as ServerConfigStreamItem);
        this.scheduleRender();
      },
      onExit: (failure) => failure && this.setNotice(`Provider status: ${failure}`, "bad"),
    });
    this.client.start();
    this.tickTimer = setInterval(() => {
      if (this.client.state.kind === "waiting" || Date.now() - this.lastRender > 15_000) this.scheduleRender();
    }, 1_000);
    this.render();
  }

  quit(code = 0): never {
    clearInterval(this.tickTimer);
    this.client.close();
    this.restore();
    process.exit(code);
  }

  private restore(): void {
    if (this.restored) return;
    this.restored = true;
    try {
      this.stdin.setRawMode?.(false);
    } catch {}
    this.stdout.write(`${RESET}\x1b[?7h\x1b[?25h\x1b[?1049l`);
  }

  private setNotice(text: string, tone: string): void {
    this.notice = { text, tone, at: Date.now() };
    this.scheduleRender();
  }

  // -------------------------------------------------------------------------
  // Thread selection

  private listOptions() {
    return { subagents: this.options.subagents, settled: this.options.settled };
  }

  private onShellChanged(): void {
    if (!this.shell.loaded) return;
    if (!this.initialized) {
      this.initialized = true;
      if (this.options.select) this.openPicker();
      else this.applySelection();
      return;
    }
    if (this.repick) {
      this.repick = false;
      if (this.selection.mode !== "ids") this.applySelection(true, true);
      return;
    }
    // Columns T3 settles, archives or deletes drop out live and free slots are refilled; --follow
    // also swaps columns as activity moves. Explicitly chosen threads (ids, picker) stay put.
    if (this.selection.mode !== "ids") this.applySelection(true);
  }

  private targetIds(refresh = false): string[] {
    const threads = this.shell.threads.values();
    switch (this.selection.mode) {
      case "recent": {
        const shown = this.columns.map((c) => c.threadId);
        return recentColumns(shown, pickThreads(threads, this.listOptions()), this.selection.count, refresh || this.options.follow);
      }
      case "all":
        return pickThreads(threads, this.listOptions());
      case "ids": {
        try {
          const { ids, unknown } = resolveThreadIds(this.selection.ids, threads);
          if (unknown.length > 0) this.setNotice(`Not in thread list (trying anyway): ${unknown.join(", ")}`, "warn");
          return ids;
        } catch (error) {
          this.setNotice(error instanceof Error ? error.message : String(error), "bad");
          return this.columns.map((c) => c.threadId);
        }
      }
    }
  }

  /** `stable` keeps surviving columns where they are and fills freed slots in place. */
  private applySelection(stable = false, refresh = false): void {
    const target = this.targetIds(refresh);
    if (!stable) {
      this.setColumns(target);
      return;
    }
    const current = this.columns.map((c) => c.threadId);
    const wanted = new Set(target);
    if (current.length === target.length && current.every((id) => wanted.has(id))) return;
    const incoming = target.filter((id) => !current.includes(id));
    const next: string[] = [];
    for (const id of current) {
      if (wanted.has(id)) next.push(id);
      else if (incoming.length > 0) next.push(incoming.shift()!);
    }
    next.push(...incoming);
    this.setColumns(next);
  }

  private setColumns(ids: string[]): void {
    const existing = new Map(this.columns.map((c) => [c.threadId, c]));
    const keep = new Set(ids);
    for (const column of this.columns) {
      if (!keep.has(column.threadId)) this.client.unsubscribe(`thread:${column.threadId}`);
    }
    if (this.search && !keep.has(this.search.column.threadId)) this.search = undefined;
    this.columns = ids.map((id) => existing.get(id) ?? this.createColumn(id));
    this.selected = Math.min(this.selected, Math.max(0, this.columns.length - 1));
    this.scheduleRender();
  }

  private createColumn(threadId: string): Column {
    const column: Column = {
      threadId,
      state: new ThreadState(threadId),
      transcript: new Transcript(),
      top: 0,
      stick: true,
      focusKey: undefined,
      anchor: 0,
      width: 40,
      height: 10,
    };
    this.client.subscribe(
      `thread:${threadId}`,
      METHODS.subscribeThread,
      // Bounded snapshots return the recent tail instead of the full (potentially huge) history.
      { threadId, acceptBoundedSnapshot: true },
      {
        onValues: (values) => {
          for (const value of values) column.state.apply(value as ThreadStreamItem);
          this.scheduleRender();
        },
        onExit: (failure) => {
          column.state.error = failure ?? "stream ended; resubscribing";
          column.state.version++;
          this.scheduleRender();
        },
      },
    );
    return column;
  }

  private openPicker(): void {
    this.picker = {
      cursor: 0,
      top: 0,
      chosen: this.columns.map((c) => c.threadId),
      subagents: this.options.subagents,
      settled: this.options.settled,
    };
    this.mode = "picker";
    this.previous = [];
    this.scheduleRender();
  }

  private pickerList() {
    const picker = this.picker!;
    return listThreads(this.shell.threads.values(), { subagents: picker.subagents, settled: picker.settled });
  }

  // -------------------------------------------------------------------------
  // Input

  private onInput(data: string): void {
    for (const key of parseKeys(data)) {
      if (key === "\x03") this.quit(0);
      if (this.mode === "picker") this.onPickerKey(key);
      else if (this.search?.editing) this.onSearchKey(key);
      else this.onDashboardKey(key);
    }
    this.render();
  }

  private onDashboardKey(key: string): void {
    const column = this.columns[this.selected];
    switch (key) {
      case "q":
      case "Q":
        this.quit(0);
      case "left":
      case "h":
      case "shift-tab":
        this.selected = Math.max(0, this.selected - 1);
        return;
      case "right":
      case "l":
      case "\t":
        this.selected = Math.min(Math.max(0, this.columns.length - 1), this.selected + 1);
        return;
      case "up":
      case "k":
        return column && this.moveFocus(column, -1);
      case "down":
      case "j":
        return column && this.moveFocus(column, 1);
      case "pageup":
      case "b":
        return column && this.page(column, -1);
      case "pagedown":
      case "f":
        return column && this.page(column, 1);
      case "\r":
      case " ":
        return column && this.toggleFocused(column);
      case "e":
        return column && this.foldAll(column, true);
      case "c":
        return column && this.foldAll(column, false);
      case "home":
      case "g":
        if (column) this.place(column, this.layoutOf(column), 0, 0);
        return;
      case "end":
      case "G":
      case "a":
        if (column) Object.assign(column, { stick: true, focusKey: undefined });
        return;
      case "A":
        for (const c of this.columns) Object.assign(c, { stick: true, focusKey: undefined });
        return;
      case "/":
        return column && this.startSearch(column);
      case "n":
        return this.search && this.jumpToMatch("older");
      case "N":
        return this.search && this.jumpToMatch("newer");
      case "escape":
        if (this.search) this.foldBack(this.search);
        this.search = undefined;
        return;
      case "shift-left":
      case "<":
      case ",":
        return this.moveColumn(-1);
      case "shift-right":
      case ">":
      case ".":
        return this.moveColumn(1);
      case "r":
      case "R":
        this.repick = this.selection.mode !== "ids";
        this.setNotice("Reconnecting and refreshing…", "info");
        this.client.reconnectNow();
        return;
      case "p":
        this.openPicker();
        return;
      case "u":
        this.usage = !this.usage;
        this.previous = [];
        return;
      default:
        if (/^[1-9]$/.test(key)) {
          const index = Number(key) - 1;
          if (index < this.columns.length) this.selected = index;
        }
    }
  }

  private moveColumn(delta: number): void {
    const to = this.selected + delta;
    if (to < 0 || to >= this.columns.length) return;
    const next = [...this.columns];
    [next[this.selected], next[to]] = [next[to], next[this.selected]];
    this.columns = next;
    this.selected = to;
    if (this.selection.mode === "ids") this.selection = { mode: "ids", ids: next.map((c) => c.threadId) };
  }

  // -------------------------------------------------------------------------
  // Focus, scrolling and folding

  private layoutOf(column: Column): Layout {
    return column.transcript.layout(column.state, column.width);
  }

  /** The view as currently drawn: following columns sit at the bottom on their last entry. */
  private view(column: Column): { layout: Layout; top: number; focus: number } {
    const layout = this.layoutOf(column);
    const limit = maxTop(layout, column.height);
    if (column.stick) return { layout, top: limit, focus: layout.entries.length - 1 };
    const focus = focusIndex(layout, column.focusKey);
    const top = focus >= 0 ? layout.start[focus] - column.anchor : column.top;
    return { layout, top: clamp(top, 0, limit), focus };
  }

  private place(column: Column, layout: Layout, focus: number, top: number): void {
    const last = layout.entries.length - 1;
    column.top = clamp(top, 0, maxTop(layout, column.height));
    column.focusKey = layout.entries[focus]?.key;
    column.anchor = focus >= 0 ? layout.start[focus] - column.top : 0;
    column.stick = focus === last && column.top >= maxTop(layout, column.height);
  }

  private moveFocus(column: Column, dir: 1 | -1): void {
    const { layout, top, focus } = this.view(column);
    const next = moveFocus(layout, focus, top, column.height, dir);
    this.place(column, layout, next.focus, next.top);
  }

  private page(column: Column, dir: 1 | -1): void {
    const { layout, top } = this.view(column);
    const nextTop = clamp(top + dir * Math.max(1, column.height - 1), 0, maxTop(layout, column.height));
    const atBottom = nextTop >= maxTop(layout, column.height);
    this.place(column, layout, atBottom && dir > 0 ? layout.entries.length - 1 : entryAt(layout, nextTop), nextTop);
  }

  /** Re-lays out after a fold change, keeping the focused entry at the same screen row. */
  private refold(column: Column, change: (layout: Layout, focus: number) => string | undefined): void {
    const before = this.view(column);
    if (before.focus < 0) return;
    const offset = before.layout.start[before.focus] - before.top;
    const key = change(before.layout, before.focus);
    const after = this.layoutOf(column);
    const focus = focusIndex(after, key);
    if (focus < 0) return;
    const anchored = clamp(after.start[focus] - offset, 0, maxTop(after, column.height));
    this.place(column, after, focus, reveal(after, focus, anchored, column.height));
  }

  /** Folding by hand takes over: a later search move must not undo it. */
  private releaseSearchFolds(column: Column): void {
    if (this.search?.column === column) this.search.revealed = [];
  }

  private toggleFocused(column: Column): void {
    this.releaseSearchFolds(column);
    this.refold(column, (layout, focus) => {
      const entry = layout.entries[focus];
      column.transcript.toggle(entry);
      return entry.key;
    });
  }

  private foldAll(column: Column, expanded: boolean): void {
    this.releaseSearchFolds(column);
    this.refold(column, (layout, focus) => {
      const entry = layout.entries[focus];
      column.transcript.setAllGroups(column.state, expanded);
      // A step inside a group that just folded resolves to its group via `owner`.
      return entry.key;
    });
  }

  // -------------------------------------------------------------------------
  // Search

  private startSearch(column: Column): void {
    if (this.search) this.foldBack(this.search);
    const { layout, top, focus } = this.view(column);
    const entry = layout.entries[focus];
    const ordinal = column.stick ? Infinity : (entry?.item?.ordinal ?? entry?.steps?.at(-1)?.ordinal ?? Infinity);
    this.search = {
      column,
      query: "",
      editing: true,
      origin: { focusKey: column.focusKey, top, stick: column.stick, anchor: column.anchor, ordinal },
      revealed: [],
      current: undefined,
      occurrence: 0,
      position: 0,
      total: 0,
    };
  }

  private onSearchKey(key: string): void {
    const search = this.search!;
    switch (key) {
      case "escape":
        this.foldBack(search);
        this.restoreOrigin(search);
        this.search = undefined;
        return;
      case "\r":
        search.editing = false;
        if (!search.query) this.search = undefined;
        return;
      case "up":
        return this.jumpToMatch("older");
      case "down":
        return this.jumpToMatch("newer");
      case "\x7f":
      case "\b":
        search.query = [...search.query].slice(0, -1).join("");
        return this.jumpToMatch("origin");
      case "\x15":
        search.query = "";
        return this.jumpToMatch("origin");
      default:
        if (key.length > 0 && key >= " " && ![...ESCAPES.map((e) => e[1]), "escape"].includes(key as KeyName)) {
          search.query += key;
          this.jumpToMatch("origin");
        }
    }
  }

  private foldBack(search: Search): void {
    foldBack(search.column.transcript, search.revealed);
    search.revealed = [];
  }

  private restoreOrigin(search: Search): void {
    const { focusKey, top, stick, anchor } = search.origin;
    Object.assign(search.column, { focusKey, top, stick, anchor });
  }

  /**
   * n (older) / N (newer) step hit by hit, like less or vim: first through the visible hits of the
   * current message or step, then on to the next item that matches. "origin" jumps to the hit
   * nearest above where the search started.
   */
  private jumpToMatch(direction: "origin" | "older" | "newer"): void {
    const search = this.search!;
    const column = search.column;
    const query = makeQuery(search.query);
    const matches = findMatches(column.state, query);
    const counts = matches.map((m) => countHits(m, query));
    search.total = counts.reduce((sum, n) => sum + n, 0);
    if (matches.length === 0) {
      this.foldBack(search);
      search.current = undefined;
      search.position = 0;
      this.restoreOrigin(search);
      return;
    }
    let index = matches.findIndex((m) => m.id === search.current);

    // Another hit in the same item: move the marker, scroll only if it is off screen.
    if (direction !== "origin" && index >= 0) {
      const layout = this.layoutOf(column);
      const entry = layout.index.get(search.current!);
      const hits = entry === undefined ? [] : occurrences(layout, entry, query);
      const next = search.occurrence + (direction === "older" ? -1 : 1);
      if (entry !== undefined && next >= 0 && next < hits.length) {
        search.occurrence = next;
        this.showHit(column, layout, entry, hits[next].row);
        search.position = this.hitPosition(counts, index, next);
        return;
      }
    }

    if (direction === "origin" || index < 0) {
      index = matches.findLastIndex((m) => m.ordinal <= search.origin.ordinal);
      if (index < 0) index = matches.length - 1;
    } else {
      index = (index + (direction === "older" ? -1 : 1) + matches.length) % matches.length;
    }
    this.foldBack(search);
    const item = matches[index];
    search.current = item.id;
    search.revealed = revealItem(column.transcript, column.state, item, query);
    const layout = this.layoutOf(column);
    const entry = focusIndex(layout, item.id);
    const hits = occurrences(layout, entry, query);
    search.occurrence = direction === "newer" ? 0 : Math.max(0, hits.length - 1);
    this.showHit(column, layout, entry, hits[search.occurrence]?.row ?? layout.start[entry]);
    search.position = this.hitPosition(counts, index, search.occurrence);
  }

  /** 1-based position of a hit among all hits, oldest first. */
  private hitPosition(counts: number[], index: number, occurrence: number): number {
    let before = 0;
    for (let i = 0; i < index; i++) before += counts[i];
    return before + Math.min(occurrence, counts[index] - 1) + 1;
  }

  /** Focuses the entry and scrolls only when the hit's row is not already on screen. */
  private showHit(column: Column, layout: Layout, entry: number, row: number): void {
    const { top } = this.view(column);
    const visible = row >= top && row < top + column.height;
    this.place(column, layout, entry, visible ? top : row - Math.floor(column.height / 3));
  }


  // -------------------------------------------------------------------------
  // Picker

  private onPickerKey(key: string): void {
    const picker = this.picker!;
    const list = this.pickerList();
    const page = Math.max(1, (this.stdout.rows || 24) - 5);
    const move = (to: number) => {
      picker.cursor = clamp(to, 0, Math.max(0, list.length - 1));
    };
    switch (key) {
      case "up":
      case "k":
        return move(picker.cursor - 1);
      case "down":
      case "j":
        return move(picker.cursor + 1);
      case "pageup":
        return move(picker.cursor - page);
      case "pagedown":
        return move(picker.cursor + page);
      case "home":
      case "g":
        return move(0);
      case "end":
      case "G":
        return move(list.length - 1);
      case " ":
      case "x": {
        const id = list[picker.cursor]?.id;
        if (!id) return;
        const at = picker.chosen.indexOf(id);
        if (at >= 0) picker.chosen.splice(at, 1);
        else picker.chosen.push(id);
        return;
      }
      case "c":
        picker.chosen = [];
        return;
      case "s":
        picker.subagents = !picker.subagents;
        picker.cursor = 0;
        return;
      case "t":
        picker.settled = !picker.settled;
        picker.cursor = 0;
        return;
      case "\r":
      case "\n": {
        const ids = picker.chosen.length > 0 ? picker.chosen : list[picker.cursor] ? [list[picker.cursor].id] : [];
        if (ids.length === 0) return;
        this.selection = { mode: "ids", ids };
        this.setColumns(ids);
        this.selected = 0;
        this.closePicker();
        return;
      }
      case "escape":
      case "q":
        if (this.columns.length === 0 && this.options.select && this.selection === this.options.selection) this.quit(0);
        this.closePicker();
        return;
    }
  }

  private closePicker(): void {
    this.mode = "dashboard";
    this.picker = undefined;
    this.previous = [];
  }

  // -------------------------------------------------------------------------
  // Rendering

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, 40);
  }

  private render(): void {
    if (this.restored) return;
    clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.lastRender = Date.now();
    const width = this.stdout.columns || 80;
    const height = this.stdout.rows || 24;
    let lines: string[];
    if (width < 30 || height < 10) {
      lines = Array.from({ length: height }, (_, i) => (i === 0 ? cell([["Terminal too small for t3-watch", "warn"]], width) : " ".repeat(width)));
    } else if (this.mode === "picker") {
      lines = this.renderPicker(width, height);
    } else {
      lines = this.renderDashboard(width, height);
    }
    let buffer = "";
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== this.previous[i]) buffer += `\x1b[${i + 1};1H${lines[i]}${RESET}`;
    }
    this.previous = lines;
    if (buffer) this.stdout.write(buffer);
  }

  private renderDashboard(width: number, height: number): string[] {
    const usageOn = this.usage && width >= 72;
    const usageWidth = usageOn ? Math.min(36, Math.max(27, Math.floor(width * 0.2))) : 0;
    const columnSpace = width - 1 - (usageOn ? usageWidth + 1 : 0);
    const maxVisible = Math.max(1, Math.floor(columnSpace / (MIN_COLUMN_WIDTH + 1)));
    const total = this.columns.length;
    const visible = Math.max(1, Math.min(total || 1, maxVisible));
    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + visible) this.offset = this.selected - visible + 1;
    this.offset = clamp(this.offset, 0, Math.max(0, total - visible));

    const contentWidth = columnSpace - visible;
    const widths = Array.from({ length: visible }, (_, i) => Math.floor(contentWidth / visible) + (i < contentWidth % visible ? 1 : 0));
    const paneWidths = usageOn ? [...widths, usageWidth] : widths;
    const bodyHeight = height - 8;

    const titles: string[] = [];
    const statuses: string[] = [];
    const footers: string[] = [];
    const bodies: string[][] = [];

    for (let v = 0; v < visible; v++) {
      const w = widths[v];
      const column = this.columns[this.offset + v];
      if (!column) {
        const message = !this.shell.loaded
          ? "Waiting for T3…"
          : "No active conversations. Press p to pick one, or start with --settled.";
        titles.push(padded([["t3-watch", "header"]], w));
        statuses.push(padded([], w));
        bodies.push(Array.from({ length: bodyHeight }, (_, i) => padded(i === 0 ? [[message, "dim"]] : [], w)));
        footers.push(padded([], w));
        continue;
      }
      const isSelected = this.offset + v === this.selected;
      const thread = this.shell.threads.get(column.threadId);
      const providerId = thread?.providerInstanceId ?? column.state.providerInstanceId;
      const title = label(thread?.title ?? column.state.title ?? shortId(column.threadId));
      titles.push(
        padded(
          [
            [isSelected ? "▶ " : "", "marker"],
            [`${providerLabel(providerId, this.providers.providers)}: `, PROVIDER_PAINT(providerId)],
            [title, isSelected ? "selected" : "header"],
          ],
          w,
        ),
      );
      const status = threadStatus(thread);
      const model = label(thread?.modelSelection?.model ?? "", 40).replace(/^claude-/, "");
      const meta = [model, label(thread?.branch ?? "", 60), thread ? lastActive(thread) : ""].filter(Boolean).join(" · ");
      statuses.push(padded([["● ", status.tone], [status.label, status.tone], [meta ? ` · ${meta}` : "", "dim"]], w));

      // Body: one gutter cell (focus marker), content, one cell of right margin.
      column.width = Math.max(4, w - 2);
      column.height = bodyHeight;
      const { layout, top, focus } = this.view(column);
      if (!column.stick) column.top = top;
      const search = this.search?.column === column && this.search.query ? this.search : undefined;
      const query = search ? makeQuery(search.query) : undefined;
      // The active match is the first hit inside the entry n/N last jumped to.
      const currentEntry = search?.current === undefined ? undefined : layout.index.get(search.current);
      const currentHits = currentEntry === undefined || !query ? [] : occurrences(layout, currentEntry, query);
      const currentHit = search && currentHits.length > 0 ? currentHits[Math.min(search.occurrence, currentHits.length - 1)] : undefined;
      const body: string[] = [];
      for (let i = 0; i < bodyHeight; i++) {
        const row = layout.rows[top + i];
        if (!row) {
          body.push(" ".repeat(w));
          continue;
        }
        const focused = isSelected && row.entry >= 0 && row.entry === focus;
        const parts = highlight(row.parts ?? [[row.text, row.style]], query, currentHit && currentHit.row === top + i ? currentHit.at : -1);
        body.push(`${focused ? paint("▎", "marker") : " "}${cell(parts, w - 1)}`);
      }
      bodies.push(body);

      const activity = threadActivity(column.state, thread);
      const below = layout.rows.length - (top + bodyHeight);
      const right = column.stick ? "" : `↓${Math.max(0, below)} · a follow`;
      const errorText = column.state.loaded && column.state.error ? ` · ⚠ ${label(column.state.error)}` : "";
      const leftWidth = Math.max(1, w - 1 - (right ? textWidth(right) + 1 : 0));
      footers.push(
        ` ${cell([["● ", activity.tone], [activity.label, activity.tone], [errorText, "warn"]], leftWidth)}${right ? ` ${paint(right, "warn")}` : ""}`,
      );
    }

    if (usageOn) {
      titles.push(padded([["Usage", "header"]], usageWidth));
      statuses.push(padded([["Claude /usage · Codex /status", "dim"]], usageWidth));
      bodies.push(this.renderUsage(usageWidth, bodyHeight));
      footers.push(padded([[this.providers.loaded ? "as reported by T3" : "waiting for T3…", "dim"]], usageWidth));
    }

    // The selected column's header gets a tinted background and a bright frame.
    const active = this.columns.length > 0 ? this.selected - this.offset : -1;
    if (active >= 0 && active < visible) {
      titles[active] = withBackground(titles[active], ACTIVE_BACKGROUND);
      statuses[active] = withBackground(statuses[active], ACTIVE_BACKGROUND);
    }
    const border = (left: string, mid: string, right: string, highlight = false) =>
      paint(left, "border") +
      paneWidths.map((w, i) => paint("─".repeat(w), highlight && i === active ? "activeBorder" : "border")).join(paint(mid, "border")) +
      paint(right, "border");
    const bar = paint("│", "border");
    const join = (cells: string[]) => bar + cells.join(bar) + bar;

    const lines: string[] = [];
    lines.push(border("┌", "┬", "┐", true));
    lines.push(join(titles));
    lines.push(join(statuses));
    lines.push(border("├", "┼", "┤", true));
    for (let i = 0; i < bodyHeight; i++) lines.push(join(bodies.map((b) => b[i])));
    lines.push(border("├", "┼", "┤"));
    lines.push(join(footers));
    lines.push(border("└", "┴", "┘"));
    lines.push(this.search?.editing ? this.renderSearchBar(width) : this.renderStatusBar(width, total, visible));
    return lines;
  }

  private findProvider(driver: "claudeAgent" | "codex"): ProviderStatus | undefined {
    const direct = this.providers.providers.get(driver);
    if (direct) return direct;
    return [...this.providers.providers.values()].find((p) => p.driver === driver && p.enabled !== false);
  }

  private renderUsage(width: number, height: number): string[] {
    const inner = width - 2;
    const sectionHeight = Math.max(1, Math.floor((height - 1) / 2));
    const toRows = (lines: UsageLine[], rows: number) => {
      const out: string[] = [];
      for (let i = 0; i < rows; i++) {
        const line = lines[i];
        if (i === rows - 1 && lines.length > rows) out.push(padded([["…", "dim"]], width));
        else out.push(padded(line ? (line.parts as Part[]) : [], width));
      }
      return out;
    };
    if (!this.providers.loaded) {
      return Array.from({ length: height }, (_, i) => padded(i === 0 ? [["Loading provider status…", "dim"]] : [], width));
    }
    const now = Date.now();
    const claude = usageLines("claudeAgent", this.findProvider("claudeAgent"), inner, now);
    const codex = usageLines("codex", this.findProvider("codex"), inner, now);
    const rows = [...toRows(claude, sectionHeight), paint("─".repeat(width), "border")];
    rows.push(...toRows(codex, height - rows.length));
    return rows.slice(0, height);
  }

  private searchSummary(search: Search): Part {
    if (!search.query) return ["", "dim"];
    return search.total ? [`  ${search.position}/${search.total}`, "info"] : ["  no matches", "warn"];
  }

  private renderSearchBar(width: number): string {
    const search = this.search!;
    return cell(
      [
        [" /", "info"],
        [search.query, "plain"],
        ["▏", "info"],
        this.searchSummary(search),
        ["   ↑ older · ↓ newer · Enter keep · Esc cancel", "dim"],
      ],
      width,
    );
  }

  private renderStatusBar(width: number, total: number, visible: number): string {
    const state = this.client.state;
    const parts: Part[] = [];
    switch (state.kind) {
      case "open":
        parts.push(["● ", "good"], [`connected ${this.options.endpointLabel()}`, "plain"]);
        if (this.options.serverVersion()) parts.push([` · T3 ${this.options.serverVersion()}`, "dim"]);
        break;
      case "connecting":
        parts.push(["◌ ", "warn"], [`connecting to ${this.options.endpointLabel()}…`, "warn"]);
        break;
      case "waiting":
        parts.push(["◌ ", "warn"], [`disconnected (${label(state.error, 80)}) · retry #${state.attempt} in ${Math.ceil(Math.max(0, state.retryAt - Date.now()) / 1000)}s`, "warn"]);
        break;
      case "fatal":
        parts.push(["✗ ", "bad"], [label(state.error), "bad"], [" · r to retry", "dim"]);
        break;
      case "closed":
        parts.push(["○ ", "dim"], ["closed", "dim"]);
        break;
    }
    parts.push([" · read-only", "dim"]);
    if (total > visible) parts.push([` · cols ${this.offset + 1}-${this.offset + visible}/${total}`, "info"]);
    if (this.search) parts.push([` · /${this.search.query}`, "info"], this.searchSummary(this.search), [" n ↑ · N ↓ · Esc", "dim"]);
    if (this.notice && Date.now() - this.notice.at < 8_000) parts.push([` · ${label(this.notice.text)}`, this.notice.tone]);
    const used = parts.reduce((n, [t]) => n + textWidth(t), 0);
    const hints = [
      "←→ column  ⇧←→ reorder  ↑↓ move  ⏎ open/fold  / search  a follow  p pick  u usage  q quit",
      "←→ ↑↓ ⏎ / a p q",
    ].find((h) => used + textWidth(h) + 2 <= width);
    if (!hints) return cell(parts, width);
    return cell([...parts, [" ".repeat(width - used - textWidth(hints) - 1), "plain"], [hints, "dim"], [" ", "plain"]], width);
  }

  private renderPicker(width: number, height: number): string[] {
    const picker = this.picker!;
    const list = this.pickerList();
    picker.cursor = Math.min(picker.cursor, Math.max(0, list.length - 1));
    const listHeight = height - 4;
    if (picker.cursor < picker.top) picker.top = picker.cursor;
    if (picker.cursor >= picker.top + listHeight) picker.top = picker.cursor - listHeight + 1;
    const flag = (on: boolean) => (on ? "on" : "off");
    const lines: string[] = [];
    lines.push(cell([[" Select T3 threads", "header"], ["  (column order = selection order)", "dim"]], width));
    lines.push(
      cell(
        [[` ↑↓ move · space select · enter open · c clear · t settled ${flag(picker.settled)} · s subagents ${flag(picker.subagents)} · esc cancel`, "dim"]],
        width,
      ),
    );
    lines.push(paint("─".repeat(width), "border"));
    for (let i = 0; i < listHeight; i++) {
      const thread = list[picker.top + i];
      if (!thread) {
        const empty = this.shell.loaded ? "  No threads. Press t to include settled ones." : "  Waiting for T3…";
        lines.push(cell(i === 0 && list.length === 0 ? [[empty, "dim"]] : [], width));
        continue;
      }
      const order = picker.chosen.indexOf(thread.id);
      const mark = order >= 0 ? `[${order + 1}]` : "[ ]";
      const status = isSettled(thread) ? { label: "Settled", tone: "dim" } : threadStatus(thread);
      const row = cell(
        [
          [` ${mark.padEnd(4)} `, order >= 0 ? "marker" : "dim"],
          [`${providerLabel(thread.providerInstanceId, this.providers.providers).padEnd(7)} `, PROVIDER_PAINT(thread.providerInstanceId)],
          ["● ", status.tone],
          [status.label.padEnd(16), status.tone],
          [`${lastActive(thread).padEnd(12)} `, "dim"],
          [`${isSubagent(thread) ? "↳ " : ""}${label(thread.title ?? "(untitled)")}`, "plain"],
          [`  ${shortId(thread.id)}`, "dim"],
        ],
        width,
      );
      lines.push(picker.top + i === picker.cursor ? `${PAINT.cursor}${row.replaceAll(RESET, `${RESET}${PAINT.cursor}`)}` : row);
    }
    lines.push(cell([[` ${picker.chosen.length} selected · ${list.length} threads`, "info"]], width));
    return lines;
  }
}
