#!/usr/bin/env -S npx tsx
//
// connect.ts — super-lite MCP client for an agent-integrations relay session.
//
// Connects to a session-based MCP relay (the protocol shipped by
// @particle-academy/agent-integrations): POST JSON-RPC to /inbox, read the
// host's responses from a server-sent-events /events stream. Drives any app
// that mounts the relay + a MicroMcpServer (e.g. the Fancy UI Agent Playground).
//
// No npm deps — uses the runtime's built-in fetch. Run with any of:
//   bun connect.ts <url> ...
//   npx tsx connect.ts <url> ...
//   deno run -A connect.ts <url> ...
//   node --experimental-strip-types connect.ts <url> ...   (Node 22.6+)
//
// Usage:
//   connect.ts <url> tools                  # list the host's tools
//   connect.ts <url> call <name> ['<json>']  # call a tool (args default {})
//   connect.ts <url> send '<jsonrpc>'        # send a raw JSON-RPC frame
//   connect.ts <url> watch                   # stream every frame from the host
//
// <url> is whatever connection URL you were handed; the token (the "inline
// key") may be in it (?token=… / ?key=…) or supplied via MCP_TOKEN.
//
// Env: MCP_TOKEN, MCP_RELAY_PATH (default whiteboard-share), MCP_INSECURE (skip TLS).

// Skip TLS verification for self-signed certs (local dev) — must run before fetch.
if (process.env.MCP_INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const RELAY_PATH = process.env.MCP_RELAY_PATH || "whiteboard-share";

type Frame = { jsonrpc: string; id?: number | string; method?: string; result?: unknown; error?: unknown; params?: unknown };

function die(msg: string): never {
  process.stderr.write("error: " + msg + "\n");
  process.exit(1);
}

function endpoints(rawUrl: string): { inbox: string; events: string } {
  const u = new URL(rawUrl);
  const token = process.env.MCP_TOKEN || u.searchParams.get("token") || u.searchParams.get("key") || "";
  const origin = u.origin;
  let session = "";
  let base = "";
  const qSession = u.searchParams.get("session");
  if (qSession) {
    session = qSession;
    base = `${origin}/${RELAY_PATH.replace(/^\/|\/$/g, "")}`;
  } else {
    let segs = u.pathname.split("/").filter(Boolean);
    if (segs.length && ["inbox", "events", "outbox"].includes(segs[segs.length - 1])) segs = segs.slice(0, -1);
    session = segs[segs.length - 1] || "";
    base = origin + segs.slice(0, -1).map((s) => "/" + s).join("");
  }
  if (!token) die("no token in URL and MCP_TOKEN unset");
  if (!session) die("could not determine session from URL");
  return {
    inbox: `${base}/${session}/inbox?token=${token}`,
    events: `${base}/${session}/events?token=${token}&direction=outbound`,
  };
}

async function main(): Promise<void> {
  const [url, cmd, ...rest] = process.argv.slice(2);
  if (!url || !cmd) {
    process.stderr.write("usage: connect.ts <url> {tools|call <name> [json]|send <frame>|watch}\n");
    process.exit(2);
  }
  const { inbox, events } = endpoints(url);

  const pending = new Map<number | string, (f: Frame) => void>();
  const watching = cmd === "watch";

  // Background SSE reader.
  const ac = new AbortController();
  const readSSE = async (): Promise<void> => {
    const res = await fetch(events, { signal: ac.signal, headers: { accept: "text/event-stream" } });
    if (!res.body) die("no SSE stream");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let frame: Frame;
        try {
          frame = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (watching) {
          console.log(JSON.stringify(frame));
        } else if (frame.id != null && pending.has(frame.id)) {
          pending.get(frame.id)!(frame);
          pending.delete(frame.id);
        }
      }
    }
  };

  if (watching) {
    process.stderr.write("# watching (Ctrl-C to stop)\n");
    await readSSE();
    return;
  }

  readSSE().catch(() => {});
  const post = (frame: Frame) =>
    fetch(inbox, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(frame) });
  const awaitId = (id: number | string, timeout = 15000): Promise<Frame | null> =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.delete(id)) resolve(null);
      }, timeout);
    });

  await new Promise((r) => setTimeout(r, 1000)); // let SSE subscribe (pings host)
  await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "connect.ts", version: "1" } } });
  if ((await awaitId(1)) === null) die("no response — is the session live and the host connected?");
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });

  let result: Frame | null;
  if (cmd === "tools") {
    await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    result = await awaitId(2);
  } else if (cmd === "call") {
    const name = rest[0];
    if (!name) die("usage: connect.ts <url> call <name> ['<json-args>']");
    const args = rest[1] ? JSON.parse(rest[1]) : {};
    await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } });
    result = await awaitId(3);
  } else if (cmd === "send") {
    if (!rest[0]) die("usage: connect.ts <url> send '<jsonrpc-frame>'");
    const frame: Frame = JSON.parse(rest[0]);
    await post(frame);
    result = frame.id != null ? await awaitId(frame.id) : null;
  } else {
    die(`unknown command: ${cmd} (use tools|call|send|watch)`);
  }

  console.log(result != null ? JSON.stringify(result, null, 2) : "(no response)");
  ac.abort();
  process.exit(0);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
