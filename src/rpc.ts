import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  assertReadOnlyMethod,
  describeFailure,
  type ClientFrame,
  type ReadOnlyMethod,
  type ServerFrame,
} from "./protocol.js";

export type ConnectionState =
  | { kind: "connecting"; attempt: number }
  | { kind: "open"; since: number }
  | { kind: "waiting"; attempt: number; retryAt: number; error: string }
  | { kind: "fatal"; error: string }
  | { kind: "closed" };

export interface StreamHandlers {
  onValues(values: unknown[]): void;
  /** The server ended the stream; `failure` is set when it ended with an error. */
  onExit?(failure: string | undefined): void;
}

export interface RpcClientOptions {
  /** Called before every connection attempt so port changes and token reissues are picked up. */
  resolve(): { url: string; token: string };
  /** Return true after replacing the token to retry immediately; false makes the failure fatal. */
  onAuthRejected?(): Promise<boolean>;
  WebSocketImpl?: typeof WebSocket;
  pingIntervalMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  handshakeTimeoutMs?: number;
  streamRetryMs?: number;
}

interface Subscription {
  key: string;
  method: ReadOnlyMethod;
  payload: unknown;
  handlers: StreamHandlers;
  requestId?: string;
  retryTimer?: NodeJS.Timeout;
  failures: number;
}

/**
 * One multiplexed, self-healing WebSocket to T3. Subscriptions are registered by key and are
 * replayed (from a fresh snapshot) after every reconnect.
 */
export class RpcClient extends EventEmitter {
  state: ConnectionState = { kind: "closed" };

  private readonly opts: Required<Omit<RpcClientOptions, "onAuthRejected">> & Pick<RpcClientOptions, "onAuthRejected">;
  private ws: WebSocket | undefined;
  private readonly subs = new Map<string, Subscription>();
  private readonly byRequestId = new Map<string, Subscription>();
  private nextRequestId = 1;
  private attempt = 0;
  /** Bumped per connection attempt so late results from an older attempt are ignored. */
  private generation = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private lastSeen = 0;
  private stopped = true;

  constructor(options: RpcClientOptions) {
    super();
    this.opts = {
      WebSocketImpl: WebSocket,
      pingIntervalMs: 15_000,
      minBackoffMs: 500,
      maxBackoffMs: 10_000,
      handshakeTimeoutMs: 10_000,
      streamRetryMs: 2_000,
      ...options,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    for (const sub of this.subs.values()) clearTimeout(sub.retryTimer);
    const ws = this.ws;
    this.ws = undefined;
    ws?.removeAllListeners();
    ws?.on("error", () => {});
    ws?.terminate();
    this.setState({ kind: "closed" });
  }

  /** Drops the socket and reconnects immediately; every stream restarts from a snapshot. */
  reconnectNow(): void {
    if (this.stopped) return;
    this.attempt = 0;
    this.connect();
  }

  subscribe(key: string, method: ReadOnlyMethod, payload: unknown, handlers: StreamHandlers): void {
    assertReadOnlyMethod(method);
    this.unsubscribe(key);
    const sub: Subscription = { key, method, payload, handlers, failures: 0 };
    this.subs.set(key, sub);
    if (this.state.kind === "open") this.sendRequest(sub);
  }

  unsubscribe(key: string): void {
    const sub = this.subs.get(key);
    if (!sub) return;
    this.subs.delete(key);
    clearTimeout(sub.retryTimer);
    if (sub.requestId) {
      this.byRequestId.delete(sub.requestId);
      this.send({ _tag: "Interrupt", requestId: sub.requestId });
    }
  }

  hasSubscription(key: string): boolean {
    return this.subs.has(key);
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.emit("state", state);
  }

  private send(frame: ClientFrame): void {
    if (frame._tag === "Request") assertReadOnlyMethod(frame.tag);
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  private sendRequest(sub: Subscription): void {
    const id = String(this.nextRequestId++);
    sub.requestId = id;
    this.byRequestId.set(id, sub);
    this.send({ _tag: "Request", id, tag: sub.method, payload: sub.payload, headers: [] });
  }

  private connect(): void {
    if (this.stopped) return;
    this.teardownSocket();
    clearTimeout(this.retryTimer);
    const generation = ++this.generation;
    let target: { url: string; token: string };
    try {
      target = this.opts.resolve();
    } catch (error) {
      this.setState({ kind: "fatal", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    this.setState({ kind: "connecting", attempt: this.attempt });
    const ws = new this.opts.WebSocketImpl(target.url, {
      headers: { authorization: `Bearer ${target.token}` },
      handshakeTimeout: this.opts.handshakeTimeoutMs,
      maxPayload: 256 * 1024 * 1024,
    });
    this.ws = ws;
    let settled = false;
    const fail = (reason: string) => {
      if (settled || this.ws !== ws) return;
      settled = true;
      this.teardownSocket();
      this.scheduleRetry(reason);
    };

    ws.on("unexpected-response", (request, response) => {
      const status = response.statusCode ?? 0;
      let body = "";
      response.on("data", (chunk: Buffer) => {
        if (body.length < 4096) body += chunk.toString("utf8");
      });
      response.on("end", () => {
        if (settled || this.ws !== ws) return;
        settled = true;
        this.teardownSocket();
        request.destroy();
        if (status === 426) {
          let message = "T3 server requires a different orchestration protocol.";
          try {
            const parsed = JSON.parse(body);
            if (parsed?.message) message = `T3 server rejected protocol 2: ${parsed.message} (server protocol ${parsed.orchestrationProtocolVersion ?? "?"})`;
          } catch {}
          this.setState({ kind: "fatal", error: message });
          return;
        }
        if (status === 401 || status === 403) {
          const retry = this.opts.onAuthRejected;
          if (!retry) {
            this.setState({ kind: "fatal", error: `T3 rejected the access token (HTTP ${status}).` });
            return;
          }
          retry().then(
            (replaced) => {
              if (this.stopped || generation !== this.generation) return;
              if (replaced) this.connect();
              else this.setState({ kind: "fatal", error: `T3 rejected the access token (HTTP ${status}).` });
            },
            (error) => {
              if (generation === this.generation) this.setState({ kind: "fatal", error: String(error?.message ?? error) });
            },
          );
          return;
        }
        this.scheduleRetry(`HTTP ${status}`);
      });
    });

    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.lastSeen = Date.now();
      this.setState({ kind: "open", since: Date.now() });
      for (const sub of this.subs.values()) {
        clearTimeout(sub.retryTimer);
        this.sendRequest(sub);
      }
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.heartbeat(ws), this.opts.pingIntervalMs);
    });

    ws.on("message", (data: WebSocket.RawData) => {
      if (this.ws !== ws) return;
      this.lastSeen = Date.now();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        this.emit("warning", "Received a malformed frame from T3.");
        return;
      }
      this.handleFrame(frame);
    });

    ws.on("error", (error: Error & { code?: string }) => fail(error.code || error.message));
    ws.on("close", (code: number, reason: Buffer) => fail(reason.toString() || `socket closed (${code})`));
  }

  private heartbeat(ws: WebSocket): void {
    if (this.ws !== ws) return;
    if (Date.now() - this.lastSeen > this.opts.pingIntervalMs * 2 + 5_000) {
      this.teardownSocket();
      this.scheduleRetry("heartbeat timeout");
      return;
    }
    this.send({ _tag: "Ping" });
  }

  private handleFrame(frame: ServerFrame): void {
    switch (frame._tag) {
      case "Chunk": {
        // Effect's socket protocol holds the next chunk until this Ack arrives.
        this.send({ _tag: "Ack", requestId: frame.requestId });
        const sub = this.byRequestId.get(frame.requestId);
        if (!sub) return;
        sub.failures = 0;
        try {
          sub.handlers.onValues(frame.values ?? []);
        } catch (error) {
          this.emit("warning", `Failed to apply update: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      case "Exit": {
        const sub = this.byRequestId.get(frame.requestId);
        this.byRequestId.delete(frame.requestId);
        if (!sub || sub.requestId !== frame.requestId) return;
        sub.requestId = undefined;
        const failure = frame.exit?._tag === "Failure" ? describeFailure(frame.exit) : undefined;
        sub.handlers.onExit?.(failure);
        // Streams are meant to stay open: re-subscribe with backoff while still wanted.
        sub.failures += 1;
        const delay = Math.min(30_000, this.opts.streamRetryMs * 2 ** Math.min(sub.failures - 1, 4));
        clearTimeout(sub.retryTimer);
        sub.retryTimer = setTimeout(() => {
          if (this.subs.get(sub.key) === sub && this.state.kind === "open" && !sub.requestId) this.sendRequest(sub);
        }, delay);
        return;
      }
      case "Ping":
        this.send({ _tag: "Pong" });
        return;
      case "Pong":
        return;
      case "Defect":
        this.emit("warning", `T3 server defect: ${describeFailure(frame.defect)}`);
        return;
      case "ClientProtocolError":
        this.emit("warning", `Protocol error: ${describeFailure(frame.error)}`);
        return;
    }
  }

  private teardownSocket(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    this.byRequestId.clear();
    for (const sub of this.subs.values()) {
      sub.requestId = undefined;
      clearTimeout(sub.retryTimer);
    }
    if (ws) {
      ws.removeAllListeners();
      ws.on("error", () => {});
      ws.terminate();
    }
  }

  private scheduleRetry(error: string): void {
    if (this.stopped) return;
    const base = Math.min(this.opts.maxBackoffMs, this.opts.minBackoffMs * 2 ** this.attempt);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.attempt += 1;
    this.setState({ kind: "waiting", attempt: this.attempt, retryAt: Date.now() + delay, error });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}
