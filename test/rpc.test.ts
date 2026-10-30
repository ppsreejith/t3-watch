import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { assertReadOnlyMethod, METHODS } from "../src/protocol.js";
import { RpcClient, type ConnectionState } from "../src/rpc.js";

interface Fake {
  server: Server;
  wss: WebSocketServer;
  port: number;
  frames: any[];
  upgrades: IncomingMessage[];
  sockets: WebSocket[];
  status?: number;
}

async function fakeT3(onRequest: (ws: WebSocket, frame: any) => void): Promise<Fake> {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const fake: Fake = { server, wss, port: 0, frames: [], upgrades: [], sockets: [] };
  server.on("upgrade", (req, socket, head) => {
    fake.upgrades.push(req);
    if (fake.status) {
      socket.end(`HTTP/1.1 ${fake.status} Nope\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{"message":"Update this client","orchestrationProtocolVersion":2}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      fake.sockets.push(ws);
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        fake.frames.push(frame);
        if (frame._tag === "Request") onRequest(ws, frame);
        if (frame._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  fake.port = (server.address() as { port: number }).port;
  return fake;
}

const waitFor = async (predicate: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("read-only allowlist rejects every mutating method", () => {
  for (const method of Object.values(METHODS)) assert.doesNotThrow(() => assertReadOnlyMethod(method));
  for (const method of ["orchestration.dispatchCommand", "orchestration.launchThread", "orchestration.stopWorkflow", "server.updateProvider", "projects.writeFile"]) {
    assert.throws(() => assertReadOnlyMethod(method), /read-only/);
  }
  const client = new RpcClient({ resolve: () => ({ url: "ws://127.0.0.1:1/ws", token: "t" }) });
  assert.throws(() => client.subscribe("x", "orchestration.dispatchCommand" as any, {}, { onValues() {} }), /read-only/);
});

test("speaks Effect RPC framing, acks chunks, interrupts and resubscribes after a drop", async () => {
  const fake = await fakeT3((ws, frame) => {
    ws.send(JSON.stringify({ _tag: "Chunk", requestId: frame.id, values: [{ kind: "snapshot", n: fake.sockets.length }] }));
  });
  const received: any[] = [];
  const states: string[] = [];
  const client = new RpcClient({
    resolve: () => ({ url: `ws://127.0.0.1:${fake.port}/ws?orchestrationProtocol=2`, token: "secret-token" }),
    minBackoffMs: 20,
    maxBackoffMs: 50,
  });
  client.on("state", (s: ConnectionState) => states.push(s.kind));
  client.subscribe("shell", METHODS.subscribeShell, {}, { onValues: (v) => received.push(...v) });
  client.start();
  await waitFor(() => received.length === 1);

  const upgrade = fake.upgrades[0];
  assert.equal(upgrade.url, "/ws?orchestrationProtocol=2");
  assert.equal(upgrade.headers.authorization, "Bearer secret-token");
  const request = fake.frames.find((f) => f._tag === "Request");
  assert.deepEqual(request, { _tag: "Request", id: request.id, tag: "orchestration.subscribeShell", payload: {}, headers: [] });
  await waitFor(() => fake.frames.some((f) => f._tag === "Ack" && f.requestId === request.id));

  // Server restart / network drop: the client reconnects and replays the subscription.
  fake.sockets[0].terminate();
  await waitFor(() => received.length === 2);
  assert.equal(received[1].n, 2);
  assert.ok(states.includes("waiting"));

  // Unsubscribing interrupts the stream on the server.
  const live = fake.frames.filter((f) => f._tag === "Request").at(-1);
  client.unsubscribe("shell");
  await waitFor(() => fake.frames.some((f) => f._tag === "Interrupt" && f.requestId === live.id));
  assert.ok(fake.frames.every((f) => f._tag !== "Request" || Object.values(METHODS).includes(f.tag)));
  client.close();
  fake.wss.close();
  fake.server.close();
});

test("protocol mismatch (HTTP 426) is fatal and auth failure (401) triggers token reissue", async () => {
  const fake = await fakeT3(() => {});
  fake.status = 426;
  const client = new RpcClient({ resolve: () => ({ url: `ws://127.0.0.1:${fake.port}/ws?orchestrationProtocol=2`, token: "t" }) });
  client.start();
  await waitFor(() => client.state.kind === "fatal");
  assert.match((client.state as { error: string }).error, /protocol/);
  client.close();

  fake.status = 401;
  let reissued = 0;
  const tokens: string[] = [];
  const authed = new RpcClient({
    resolve: () => {
      tokens.push(reissued ? "fresh" : "stale");
      return { url: `ws://127.0.0.1:${fake.port}/ws?orchestrationProtocol=2`, token: tokens.at(-1)! };
    },
    onAuthRejected: async () => {
      reissued++;
      fake.status = undefined;
      return true;
    },
  });
  authed.start();
  await waitFor(() => authed.state.kind === "open");
  assert.equal(reissued, 1);
  assert.equal(fake.upgrades.at(-1)!.headers.authorization, "Bearer fresh");
  authed.close();
  fake.wss.close();
  fake.server.close();
});
