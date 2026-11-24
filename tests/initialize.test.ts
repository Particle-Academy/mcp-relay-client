import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";

/**
 * The initialize handshake every client sends, asserted on the wire.
 *
 * All five implementations hardcode the MCP revision they request, and nothing
 * compared them: four copies of `2025-06-18` plus the library's, one revision
 * behind the spec. This runs each client against an in-process fake
 * relay and reads the `initialize` frame the relay actually received.
 *
 * It also proves the clients still interoperate with a host that NEGOTIATES
 * DOWN. MCP lifecycle: "If the server supports the requested protocol version,
 * it MUST respond with the same version. Otherwise, the server MUST respond with
 * another protocol version it supports." agent-integrations' MicroMcpServer
 * answers 2025-06-18 by default, so a client that requested 2025-11-25 and then
 * refused a 2025-06-18 answer would break against every bridge in the kit.
 * Nothing these clients send (initialize, tools/list, tools/call) differs
 * between 2024-11-05 and 2025-11-25, so they accept any revision the host picks.
 *
 * Runtimes that are not installed are skipped by name, visibly, never passed.
 */
const SPEC_REVISION = "2025-11-25";

const root = resolve(__dirname, "..");
const TSX = resolve(root, "node_modules/tsx/dist/cli.mjs");

type Frame = { jsonrpc: string; id?: number | string; method?: string; params?: Record<string, unknown> };

/** A fake agent-integrations relay: POST /inbox, SSE /events and long-poll /poll. */
class FakeRelay {
  server: Server;
  received: Frame[] = [];
  /** The protocolVersion the fake host answers initialize with. */
  answer = SPEC_REVISION;
  private sse = new Set<ServerResponse>();
  private queues = new Map<string, string[]>();
  private waiters = new Map<string, () => void>();
  private nextSub = 1;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/p?session=S&token=T`;
  }

  reset(answer: string): void {
    this.received = [];
    this.answer = answer;
  }

  private broadcast(frame: unknown): void {
    const data = JSON.stringify(frame);
    for (const res of this.sse) res.write(`data: ${data}\n\n`);
    for (const [sub, q] of this.queues) {
      q.push(data);
      this.waiters.get(sub)?.();
    }
  }

  private reply(frame: Frame): unknown {
    if (frame.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: frame.id,
        result: { protocolVersion: this.answer, capabilities: { tools: {} }, serverInfo: { name: "fake-host", version: "0" } },
      };
    }
    if (frame.method === "tools/list") {
      return { jsonrpc: "2.0", id: frame.id, result: { tools: [{ name: "probe_tool", inputSchema: { type: "object" } }] } };
    }
    return { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Method not found" } };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && u.pathname.endsWith("/inbox")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const frame = JSON.parse(body) as Frame;
      this.received.push(frame);
      res.writeHead(202).end();
      if (frame.id != null) setTimeout(() => this.broadcast(this.reply(frame)), 10);
      return;
    }
    if (u.pathname.endsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      this.sse.add(res);
      req.on("close", () => this.sse.delete(res));
      return;
    }
    if (u.pathname.endsWith("/poll")) {
      let sub = u.searchParams.get("subscriber") ?? "";
      if (!sub || !this.queues.has(sub)) {
        sub = `sub${this.nextSub++}`;
        this.queues.set(sub, []);
      }
      const q = this.queues.get(sub)!;
      // A fixed long-poll window, never the requested duration: the request only says whether to wait.
      const wait = Number(u.searchParams.get("wait") ?? 0) > 0 ? 1000 : 0;
      if (q.length === 0 && wait > 0) {
        await new Promise<void>((done) => {
          const t = setTimeout(done, wait);
          this.waiters.set(sub, () => {
            clearTimeout(t);
            done();
          });
        });
        this.waiters.delete(sub);
      }
      const frames = q.splice(0);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ subscriber: sub, frames }));
      return;
    }
    res.writeHead(404).end();
  }

  close(): Promise<void> {
    for (const res of this.sse) res.end();
    return new Promise((done) => this.server.close(() => done()));
  }
}

const has = (cmd: string, args: string[]): boolean => {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const CLIENTS: Array<{ name: string; available: boolean; argv: (url: string) => [string, string[]] }> = [
  { name: "library (src/index.ts)", available: true, argv: (url) => ["node", [TSX, "src/index.ts", url, "tools"]] },
  { name: "connect.ts", available: true, argv: (url) => ["node", [TSX, "connect.ts", url, "tools"]] },
  { name: "connect.sh", available: has("bash", ["-c", "command -v curl"]), argv: (url) => ["bash", ["connect.sh", url, "tools"]] },
  { name: "connect.py", available: has("python", ["--version"]), argv: (url) => ["python", ["connect.py", url, "tools"]] },
  { name: "connect.go", available: has("go", ["version"]), argv: (url) => ["go", ["run", "./connect.go", url, "tools"]] },
];

/** Run a client asynchronously: the fake relay lives in this process, so a sync spawn would deadlock it. */
function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(cmd, args, { cwd: root, timeout: 90_000, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number }).code ?? -1) : 0;
      done({ code: typeof code === "number" ? code : -1, out: `${stdout}${stderr}` });
    });
  });
}

const relay = new FakeRelay();

beforeAll(() => new Promise<void>((done) => relay.server.listen(0, "127.0.0.1", () => done())));
afterAll(() => relay.close());

describe.sequential("initialize handshake on the wire", () => {
  for (const client of CLIENTS) {
    describe.skipIf(!client.available)(client.name, () => {
      it(`requests MCP ${SPEC_REVISION}`, async () => {
        relay.reset(SPEC_REVISION);
        const [cmd, args] = client.argv(relay.url());
        const { code, out } = await run(cmd, args);

        const init = relay.received.find((f) => f.method === "initialize");
        expect(init, `no initialize frame reached the relay. Output:\n${out}`).toBeDefined();
        expect(init!.params?.protocolVersion).toBe(SPEC_REVISION);
        expect(out).toContain("probe_tool");
        expect(code, out).toBe(0);
      }, 120_000);

      it("still completes when the host negotiates down to 2025-06-18", async () => {
        relay.reset("2025-06-18");
        const [cmd, args] = client.argv(relay.url());
        const { code, out } = await run(cmd, args);

        expect(relay.received.some((f) => f.method === "notifications/initialized"), out).toBe(true);
        expect(out).toContain("probe_tool");
        expect(code, out).toBe(0);
      }, 120_000);
    });
  }
});
