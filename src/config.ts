import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ORCHESTRATION_PROTOCOL_VERSION } from "./protocol.js";

export const READ_SCOPE = "orchestration:read";
export const TOKEN_LABEL = "t3-watch";

export function t3Home(): string {
  return process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
}

export function configDir(): string {
  return process.env.T3_WATCH_CONFIG_DIR || path.join(os.homedir(), ".config", "t3-watch");
}

export function defaultTokenPath(): string {
  return path.join(configDir(), "token");
}

export interface ServerRuntime {
  port?: number;
  origin?: string;
  pid?: number;
  serverVersion?: string;
  startedAt?: string;
}

/** T3 rewrites this on every server start, so read it on each (re)connect attempt. */
export function readServerRuntime(home = t3Home()): ServerRuntime | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, "userdata", "server-runtime.json"), "utf8"));
    return {
      port: typeof raw.port === "number" ? raw.port : undefined,
      origin: typeof raw.origin === "string" ? raw.origin : undefined,
      pid: typeof raw.pid === "number" ? raw.pid : undefined,
      serverVersion: typeof raw.serverVersion === "string" ? raw.serverVersion : undefined,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
    };
  } catch {
    return undefined;
  }
}

export interface Endpoint {
  wsUrl: string;
  display: string;
  serverVersion?: string;
  source: "flag" | "runtime" | "default";
}

export function buildWsUrl(base: string): string {
  const url = new URL(base.includes("://") ? base : `http://${base}`);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  url.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
  return url.toString();
}

export function resolveEndpoint(override?: string): Endpoint {
  if (override) {
    const wsUrl = buildWsUrl(override);
    return { wsUrl, display: new URL(wsUrl).host, source: "flag" };
  }
  const runtime = readServerRuntime();
  const port = runtime?.port ?? 3773;
  const wsUrl = buildWsUrl(`http://127.0.0.1:${port}`);
  return {
    wsUrl,
    display: `127.0.0.1:${port}`,
    serverVersion: runtime?.serverVersion,
    source: runtime ? "runtime" : "default",
  };
}

export function readToken(file: string): string | undefined {
  try {
    const token = fs.readFileSync(file, "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

interface CliCandidate {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Prefer the `t3` shim T3 Code installs; fall back to running the app bundle's CLI directly. */
function findT3Cli(): CliCandidate | undefined {
  const shim = path.join(t3Home(), "bin", "t3");
  if (fs.existsSync(shim)) return { command: shim, args: [], env: process.env };
  for (const name of ["T3 Code (Beta).app", "T3 Code.app"]) {
    const app = path.join("/Applications", name);
    const exe = path.join(app, "Contents", "MacOS", name.replace(/\.app$/, ""));
    const bin = path.join(app, "Contents", "Resources", "app.asar", "apps", "server", "dist", "bin.mjs");
    if (fs.existsSync(exe)) {
      return {
        command: exe,
        args: [bin],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", T3CODE_HOME: t3Home() },
      };
    }
  }
  return undefined;
}

/**
 * Mints a bearer token limited to `orchestration:read` through T3's own CLI and stores it
 * with mode 0600. The token never reaches stdout, stderr or logs.
 */
export async function issueReadOnlyToken(file: string): Promise<string> {
  const cli = findT3Cli();
  if (!cli) {
    throw new Error("Could not find the T3 Code CLI (~/.t3/bin/t3). Open T3 Code once, or pass T3_WATCH_TOKEN.");
  }
  const args = [
    ...cli.args,
    "auth",
    "session",
    "issue",
    "--scope",
    READ_SCOPE,
    "--label",
    TOKEN_LABEL,
    "--ttl",
    "365d",
    "--token-only",
  ];
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(cli.command, args, { env: cli.env, timeout: 60_000, maxBuffer: 1 << 20 }, (error, out, err) => {
      if (error) {
        const detail = String(err || "").trim().split("\n").slice(-1)[0] || error.message;
        reject(new Error(`T3 CLI failed to issue a read-only token: ${detail}`));
      } else {
        resolve(String(out));
      }
    });
  });
  const token = stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!/^\S{16,}$/.test(token)) throw new Error("T3 CLI did not return a token.");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return token;
}

export interface SessionInfo {
  sessionId: string;
  scopes: string[];
  label?: string;
  expiresAt?: string;
  lastConnectedAt?: string;
}

/** Lists the `t3-watch` sessions (without secrets) so `--doctor` can prove their scopes. */
export async function listWatchSessions(): Promise<SessionInfo[] | undefined> {
  const cli = findT3Cli();
  if (!cli) return undefined;
  const stdout = await new Promise<string | undefined>((resolve) => {
    execFile(
      cli.command,
      [...cli.args, "auth", "session", "list", "--json"],
      { env: cli.env, timeout: 60_000, maxBuffer: 8 << 20 },
      (error, out) => resolve(error ? undefined : String(out)),
    );
  });
  if (!stdout) return undefined;
  try {
    const parsed = JSON.parse(stdout);
    const sessions: unknown[] = Array.isArray(parsed) ? parsed : [];
    return sessions
      .map((raw) => raw as Record<string, any>)
      .filter((s) => s?.client?.label === TOKEN_LABEL)
      .map((s) => ({
        sessionId: String(s.sessionId),
        scopes: Array.isArray(s.scopes) ? s.scopes.map(String) : [],
        label: s.client?.label,
        expiresAt: s.expiresAt,
        lastConnectedAt: s.lastConnectedAt,
      }));
  } catch {
    return undefined;
  }
}
