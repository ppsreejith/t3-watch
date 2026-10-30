import { createRequire } from "node:module";
import { defaultTokenPath, issueReadOnlyToken, readToken, resolveEndpoint } from "./config.js";
import { runDoctor, runList, runPrint } from "./headless.js";
import { RpcClient } from "./rpc.js";
import { Dashboard, type Selection } from "./ui.js";

export const HELP = `t3-watch: live, read-only, side-by-side view of T3 Code conversations

Usage
  t3-watch                   The 3 most recently active conversations
  t3-watch -n 4              The 4 most recently active
  t3-watch --all             Every active conversation (←/→ pages through columns)
  t3-watch --select          Pick conversations interactively (pick order = column order)
  t3-watch <id> [<id> ...]   Specific conversations in that order (id prefix from --list)
  t3-watch --list, -l        List conversations and their ids
  t3-watch --print <id>      Print a conversation's recent transcript
  t3-watch --doctor          Check the server, protocol, token scopes and data access

Options
  -n, --count <n>       Number of recent conversations (default 3)
  -a, --all             All active conversations instead of the most recent
      --settled         Include settled, snoozed and archived conversations
      --subagents       Include subagent conversations
  -s, --select          Interactive picker
  -f, --follow          Swap columns as other conversations become active
      --no-usage        Hide the Claude/Codex usage column
      --url <url>       T3 server (default: from ~/.t3/userdata/server-runtime.json)
      --token-file <p>  Token location (default ~/.config/t3-watch/token)
      --reissue-token   Issue a fresh read-only token
  -h, --help / -v, --version

Keys
  ←/→ column   ↑/↓ move focus   PgUp/PgDn page   g/G top/bottom   a follow (A: all)
  Enter/Space  open or fold the focused message, step group or step
  e / c        open / fold every step group in the column
  /            search the column (n older, N newer, Esc clear)
  ⇧←/⇧→, < / > move column   1-9 jump to column   p picker   u usage   r reconnect   q quit
  Vim-style h/j/k/l, b/f (page), Tab/Shift-Tab (column) and ,/. (move column) also work.

Read-only: t3-watch uses a token limited to "orchestration:read" and only subscribes to
read streams. It never sends prompts, changes threads or starts agents.
`;

export interface CliArgs {
  count: number;
  all: boolean;
  select: boolean;
  ids: string[];
  subagents: boolean;
  settled: boolean;
  follow: boolean;
  usage: boolean;
  url?: string;
  tokenFile?: string;
  reissueToken: boolean;
  list: boolean;
  doctor: boolean;
  print?: string;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    count: 3,
    all: false,
    select: false,
    ids: [],
    subagents: false,
    settled: false,
    follow: false,
    usage: true,
    reissueToken: false,
    list: false,
    doctor: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    const count = (raw: string) => {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error(`Invalid count "${raw}" (expected 1-50)`);
      return n;
    };
    if (/^-n\d+$/.test(flag)) {
      args.count = count(flag.slice(2));
      continue;
    }
    switch (flag) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-v":
      case "--version":
        args.version = true;
        break;
      case "-n":
      case "--count":
        args.count = count(value());
        break;
      case "-a":
      case "--all":
        args.all = true;
        break;
      case "-s":
      case "--select":
        args.select = true;
        break;
      case "--subagents":
        args.subagents = true;
        break;
      case "--settled":
        args.settled = true;
        break;
      case "-f":
      case "--follow":
        args.follow = true;
        break;
      case "--no-usage":
        args.usage = false;
        break;
      case "--url":
        args.url = value();
        break;
      case "--token-file":
        args.tokenFile = value();
        break;
      case "--reissue-token":
        args.reissueToken = true;
        break;
      case "-l":
      case "--list":
        args.list = true;
        break;
      case "--doctor":
        args.doctor = true;
        break;
      case "--print":
        args.print = value();
        break;
      case "--":
        args.ids.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      default:
        if (flag.startsWith("-")) throw new Error(`Unknown option ${flag} (see --help)`);
        args.ids.push(arg);
    }
  }
  if (args.all && args.ids.length > 0) throw new Error("--all cannot be combined with thread ids");
  return args;
}

export function selectionFor(args: CliArgs): Selection {
  if (args.ids.length > 0) return { mode: "ids", ids: args.ids };
  if (args.all) return { mode: "all" };
  return { mode: "recent", count: args.count };
}

export async function main(argv: string[]): Promise<void> {
  // `t3-watch --list | head` closes the pipe early; that is not an error.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };
    process.stdout.write(`t3-watch ${pkg.version} (T3 orchestration protocol 2)\n`);
    return;
  }

  const tokenFile = args.tokenFile ?? defaultTokenPath();
  const envToken = process.env.T3_WATCH_TOKEN?.trim() || undefined;
  if (envToken && args.reissueToken) process.stderr.write("t3-watch: T3_WATCH_TOKEN is set; ignoring --reissue-token\n");
  let token = envToken ?? (args.reissueToken ? undefined : readToken(tokenFile));
  if (!token) {
    process.stderr.write("t3-watch: issuing a read-only (orchestration:read) T3 access token via `t3 auth session issue`…\n");
    token = await issueReadOnlyToken(tokenFile);
    process.stderr.write(`t3-watch: saved to ${tokenFile} (mode 600)\n`);
  }

  let lastReissue = 0;
  const client = new RpcClient({
    resolve: () => ({ url: resolveEndpoint(args.url).wsUrl, token: token! }),
    onAuthRejected: async () => {
      // A revoked or expired file token is replaced once a minute at most; env tokens are left alone.
      if (envToken || Date.now() - lastReissue < 60_000) return false;
      lastReissue = Date.now();
      token = await issueReadOnlyToken(tokenFile);
      return true;
    },
  });

  if (args.doctor) {
    const ok = await runDoctor(client, { tokenFile, tokenFromEnv: Boolean(envToken), endpoint: resolveEndpoint(args.url).display });
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (args.list) return runList(client, { subagents: args.subagents, settled: args.settled });
  if (args.print) return runPrint(client, args.print);

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error("the dashboard needs an interactive terminal (try --list, --print <id> or --doctor)");
  }
  new Dashboard(client, {
    selection: selectionFor(args),
    subagents: args.subagents,
    settled: args.settled,
    follow: args.follow,
    usage: args.usage,
    select: args.select,
    endpointLabel: () => resolveEndpoint(args.url).display,
    serverVersion: () => (args.url ? undefined : resolveEndpoint().serverVersion),
  }).start();
}
