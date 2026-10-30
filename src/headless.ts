import fs from "node:fs";
import { listWatchSessions, readServerRuntime, READ_SCOPE } from "./config.js";
import { formatAgo, label, lastActive, providerLabel, threadStatus, usageLines } from "./format.js";
import { METHODS, type ReadOnlyMethod, type ServerConfigStreamItem, type ShellStreamItem, type ThreadStreamItem } from "./protocol.js";
import type { ConnectionState, RpcClient } from "./rpc.js";
import { isListed, isSettled, isSubagent, listThreads, resolveThreadIds, shortId, sortByActivity } from "./select.js";
import { ProvidersState, ShellState, ThreadState } from "./store.js";
import { Transcript } from "./transcript.js";

/** Subscribes until `done` returns true, then unsubscribes. Fails fast on fatal connection errors. */
export function collect(
  client: RpcClient,
  key: string,
  method: ReadOnlyMethod,
  payload: unknown,
  onValues: (values: unknown[]) => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let lastError = "";
    const finish = (error?: Error) => {
      clearTimeout(timer);
      client.off("state", onState);
      client.unsubscribe(key);
      if (error) reject(error);
      else resolve();
    };
    const onState = (state: ConnectionState) => {
      if (state.kind === "fatal") finish(new Error(state.error));
      if (state.kind === "waiting") lastError = state.error;
    };
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for T3${lastError ? ` (${lastError})` : ""}. Is T3 Code running?`)),
      timeoutMs,
    );
    client.on("state", onState);
    client.subscribe(key, method, payload, {
      onValues: (values) => {
        if (onValues(values)) finish();
      },
      onExit: (failure) => failure && finish(new Error(failure)),
    });
    client.start();
  });
}

async function loadShell(client: RpcClient): Promise<ShellState> {
  const shell = new ShellState();
  await collect(client, "shell", METHODS.subscribeShell, {}, (values) => {
    for (const value of values) shell.apply(value as ShellStreamItem);
    return shell.loaded;
  });
  return shell;
}

async function loadProviders(client: RpcClient): Promise<ProvidersState> {
  const providers = new ProvidersState();
  await collect(client, "config", METHODS.subscribeServerConfig, {}, (values) => {
    for (const value of values) providers.apply(value as ServerConfigStreamItem);
    return providers.loaded;
  });
  return providers;
}

async function loadThread(client: RpcClient, threadId: string): Promise<ThreadState> {
  const state = new ThreadState(threadId);
  await collect(client, `thread:${threadId}`, METHODS.subscribeThread, { threadId, acceptBoundedSnapshot: true }, (values) => {
    for (const value of values) state.apply(value as ThreadStreamItem);
    return state.loaded;
  });
  return state;
}

export async function runList(client: RpcClient, options: { subagents: boolean; settled: boolean }): Promise<void> {
  const shell = await loadShell(client);
  client.close();
  const threads = listThreads(shell.threads.values(), options);
  const out = process.stdout;
  out.write(`${"ID".padEnd(10)}${"AGENT".padEnd(8)}${"STATUS".padEnd(17)}${"ACTIVE".padEnd(13)}TITLE\n`);
  for (const t of threads) {
    const status = isSettled(t) ? "Settled" : threadStatus(t).label;
    const title = `${isSubagent(t) ? "↳ " : ""}${label(t.title ?? "(untitled)")}`;
    out.write(`${shortId(t.id).padEnd(10)}${providerLabel(t.providerInstanceId).padEnd(8)}${status.padEnd(17)}${lastActive(t).padEnd(13)}${title}\n`);
  }
  const hidden = shell.threads.size - threads.length;
  if (hidden > 0) out.write(`\n${hidden} more hidden: --settled includes settled/archived, --subagents includes subagents.\n`);
}

/** Prints messages and every step summary (step groups opened, step details folded). */
export async function runPrint(client: RpcClient, input: string): Promise<void> {
  const shell = await loadShell(client);
  const [threadId] = resolveThreadIds([input], shell.threads.values()).ids;
  const state = await loadThread(client, threadId);
  client.close();
  const thread = shell.threads.get(threadId);
  const out = process.stdout;
  out.write(`# ${providerLabel(thread?.providerInstanceId ?? state.providerInstanceId)}: ${label(thread?.title ?? state.title ?? threadId)}\n`);
  out.write(`# ${threadStatus(thread).label} · ${state.items.size} items${state.hasMoreHistory ? " (recent window)" : ""}\n\n`);
  const transcript = new Transcript();
  transcript.setAllGroups(state, true);
  for (const row of transcript.layout(state, Math.min(out.columns || 100, 120)).rows) out.write(`${row.text}\n`);
}

export async function runDoctor(client: RpcClient, context: { tokenFile: string; tokenFromEnv: boolean; endpoint: string }): Promise<boolean> {
  let ok = true;
  const line = (label: string, value: string, good = true) => {
    if (!good) ok = false;
    process.stdout.write(`${good ? "✓" : "✗"} ${label.padEnd(15)} ${value}\n`);
  };

  const runtime = readServerRuntime();
  if (runtime) {
    let alive = false;
    try {
      if (runtime.pid) process.kill(runtime.pid, 0);
      alive = Boolean(runtime.pid);
    } catch {}
    line("T3 server", `T3 Code ${runtime.serverVersion ?? "?"} · port ${runtime.port} · pid ${runtime.pid}${alive ? " (running)" : " (not running?)"}`, alive);
  } else {
    line("T3 server", "server-runtime.json not found; using default port 3773", false);
  }

  if (context.tokenFromEnv) {
    line("Access token", "from T3_WATCH_TOKEN (value not shown)");
  } else {
    const mode = (fs.statSync(context.tokenFile).mode & 0o777).toString(8);
    line("Access token", `${context.tokenFile} · mode ${mode} (value not shown)`, mode === "600");
  }

  const sessions = await listWatchSessions();
  if (sessions === undefined) {
    line("Token scopes", "could not query `t3 auth session list`", false);
  } else {
    const scopes = [...new Set(sessions.flatMap((s) => s.scopes))];
    const readOnly = scopes.length > 0 && scopes.every((s) => s === READ_SCOPE);
    line("Token scopes", `${sessions.length} t3-watch session(s) · scopes: ${scopes.join(", ") || "none"}${readOnly ? " (read-only)" : ""}`, readOnly);
  }

  const started = Date.now();
  const shell = await loadShell(client);
  line("Protocol", `orchestration protocol 2 over ${context.endpoint} · connected in ${Date.now() - started} ms`);
  const all = [...shell.threads.values()];
  const top = all.filter((t) => !isSubagent(t) && !t.deletedAt);
  const active = all.filter((t) => isListed(t, { subagents: false, settled: false }));
  const byProvider = new Map<string, number>();
  for (const t of all) byProvider.set(providerLabel(t.providerInstanceId), (byProvider.get(providerLabel(t.providerInstanceId)) ?? 0) + 1);
  line(
    "Threads",
    `${all.length} total · ${top.length} top-level (${active.length} active) · ${all.filter(isSubagent).length} subagents · ${all.filter((t) => isSettled(t)).length} settled · ${[...byProvider].map(([k, v]) => `${k} ${v}`).join(", ")}`,
  );

  const recent = sortByActivity(active.length > 0 ? active : top)[0];
  if (recent) {
    const state = await loadThread(client, recent.id);
    const last = state.sorted().at(-1);
    line(
      "Thread read",
      `"${label(recent.title)}" · ${state.items.size} items${state.hasMoreHistory ? " (bounded window)" : ""} · last item ${formatAgo(last?.updatedAt)}`,
      state.loaded,
    );
  }

  const providers = await loadProviders(client);
  for (const id of ["claudeAgent", "codex"] as const) {
    const provider = providers.providers.get(id);
    const windows = provider?.usageLimits?.windows ?? [];
    const summary = windows.map((w) => `${w.label} ${Math.round(w.usedPercent)}%`).join(" · ") || usageLines(id, provider, 60)[1]?.parts[0]?.[0] || "none";
    line(`${providerLabel(id)} usage`, summary, Boolean(provider));
  }
  line("Client calls", `${Object.values(METHODS).join(", ")} (allowlist, nothing else is ever sent)`);
  client.close();
  return ok;
}
