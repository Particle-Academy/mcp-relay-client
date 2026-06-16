// mcp-relay-client — zero-install MCP client + stdio bridge for an
// agent-integrations relay session (the protocol shipped by
// @particle-academy/agent-integrations: POST JSON-RPC to /inbox, read the
// host's frames from an SSE /events stream). Drives any app that mounts the
// relay + a MicroMcpServer — e.g. the Fancy UI Agent Playground or a site-wide
// co-browse session.
//
// Run with no subcommand to act as a STDIO MCP SERVER (bridge): any MCP client
// (Claude Code/Desktop/Cursor) can mount a live browser session via
//   { "command": "npx", "args": ["-y", "mcp-relay-client", "<url>"] }
// or use the one-shot verbs (tools | call | send | watch) from a shell.

import process from "node:process";
import { createInterface } from "node:readline";
import { endpoints, type Endpoints } from "./endpoints.js";

const VERSION = "0.1.0";

type Frame = {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: unknown;
  params?: unknown;
};

const HELP = `mcp-relay-client v${VERSION} — connect to an agent-integrations relay MCP session.

Usage
  npx -y mcp-relay-client <url>                 # stdio MCP bridge (default)
  npx -y mcp-relay-client <url> tools           # list the host's tools
  npx -y mcp-relay-client <url> call <name> ['<json>']
  npx -y mcp-relay-client <url> send '<jsonrpc-frame>'
  npx -y mcp-relay-client <url> watch           # stream every frame from the host

<url> is the session URL you were handed (Add-to-Claude / share link). The token
may be in it (?token=… / ?key=…) or passed via --token / MCP_TOKEN.

As an MCP server (mount a live browser session in any MCP client):
  { "command": "npx", "args": ["-y", "mcp-relay-client", "<url>"] }

Options / env
  --token <tok>     MCP_TOKEN      session token (if not in the URL)
  --relay <path>    MCP_RELAY_PATH relay mount path (default whiteboard-share)
  --insecure        MCP_INSECURE   skip TLS verification (self-signed, local dev)
  --help -h         --version -v`;

function die(msg: string): never {
  process.stderr.write(`mcp-relay-client: ${msg}\n`);
  process.exit(1);
}

/** Read the SSE /events stream, invoking `onFrame` for each JSON-RPC frame. */
async function readSSE(
  url: string,
  onFrame: (f: Frame) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(url, { signal, headers: { accept: "text/event-stream" } });
  if (!res.ok || !res.body) throw new Error(`SSE connect failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const data = line.slice(6);
      if (data === "invalid_token") throw new Error("relay rejected the token");
      let frame: Frame;
      try {
        frame = JSON.parse(data);
      } catch {
        continue;
      }
      onFrame(frame);
    }
  }
}

function post(inbox: string, frame: Frame): Promise<unknown> {
  return fetch(inbox, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(frame),
  });
}

/**
 * STDIO MCP bridge: newline-delimited JSON-RPC on stdin → relay inbox; relay
 * SSE frames → stdout (one JSON per line). Transparent — the initialize
 * handshake, tool calls, and the host's `notifications/agent_activity` reverse
 * channel all flow through untouched. Reconnects the SSE while stdin is open.
 */
async function bridge(ep: Endpoints): Promise<void> {
  const ac = new AbortController();
  let closing = false;

  // Relay → stdout, with reconnect (the SSE drops on idle/redeploy).
  void (async () => {
    let attempt = 0;
    while (!closing) {
      try {
        await readSSE(
          ep.events,
          (frame) => process.stdout.write(JSON.stringify(frame) + "\n"),
          ac.signal,
        );
        attempt = 0; // clean end → reconnect immediately
      } catch (e) {
        if (closing) return;
        process.stderr.write(
          `mcp-relay-client: SSE ${e instanceof Error ? e.message : String(e)} — reconnecting\n`,
        );
      }
      if (closing) return;
      await new Promise((r) => setTimeout(r, Math.min(5000, 250 * 2 ** attempt++)));
    }
  })();

  // stdin → relay inbox (each line is one JSON-RPC frame).
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    let frame: Frame;
    try {
      frame = JSON.parse(t);
    } catch {
      process.stderr.write("mcp-relay-client: skipping non-JSON stdin line\n");
      return;
    }
    post(ep.inbox, frame).catch((e) =>
      process.stderr.write(`mcp-relay-client: inbox POST failed: ${e}\n`),
    );
  });

  process.stderr.write(`mcp-relay-client: bridging session ${ep.session} (Ctrl-C to stop)\n`);

  await new Promise<void>((resolve) => {
    const stop = () => {
      closing = true;
      ac.abort();
      rl.close();
      resolve();
    };
    rl.on("close", stop); // stdin EOF → client disconnected
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

/** One-shot request/response over the relay (tools | call | send). */
async function command(ep: Endpoints, cmd: string, rest: string[]): Promise<void> {
  const ac = new AbortController();
  const pending = new Map<number | string, (f: Frame) => void>();

  readSSE(
    ep.events,
    (frame) => {
      if (frame.id != null && pending.has(frame.id)) {
        pending.get(frame.id)!(frame);
        pending.delete(frame.id);
      }
    },
    ac.signal,
  ).catch(() => {});

  const awaitId = (id: number | string, timeout = 15000): Promise<Frame | null> =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.delete(id)) resolve(null);
      }, timeout);
    });

  await new Promise((r) => setTimeout(r, 1000)); // let the SSE subscribe (pings host)
  await post(ep.inbox, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-relay-client", version: VERSION },
    },
  });
  if ((await awaitId(1)) === null) {
    die("no response — is the session live and the host connected?");
  }
  await post(ep.inbox, { jsonrpc: "2.0", method: "notifications/initialized" });

  let result: Frame | null;
  if (cmd === "tools") {
    await post(ep.inbox, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    result = await awaitId(2);
  } else if (cmd === "call") {
    const name = rest[0];
    if (!name) die("usage: <url> call <name> ['<json-args>']");
    let args: unknown = {};
    if (rest[1]) {
      try {
        args = JSON.parse(rest[1]);
      } catch {
        die("call arguments must be valid JSON");
      }
    }
    await post(ep.inbox, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } });
    result = await awaitId(3);
  } else if (cmd === "send") {
    if (!rest[0]) die("usage: <url> send '<jsonrpc-frame>'");
    let frame: Frame;
    try {
      frame = JSON.parse(rest[0]);
    } catch {
      die("send frame must be valid JSON");
    }
    await post(ep.inbox, frame);
    result = frame.id != null ? await awaitId(frame.id) : null;
  } else {
    die(`unknown command: ${cmd} (use tools | call | send | watch, or omit for the stdio bridge)`);
  }

  process.stdout.write((result != null ? JSON.stringify(result, null, 2) : "(no response)") + "\n");
  ac.abort();
  process.exit(0);
}

/** Stream every frame the host emits (debugging / observing). */
async function watch(ep: Endpoints): Promise<void> {
  const ac = new AbortController();
  process.stderr.write(`mcp-relay-client: watching session ${ep.session} (Ctrl-C to stop)\n`);
  process.on("SIGINT", () => {
    ac.abort();
    process.exit(0);
  });
  await readSSE(ep.events, (frame) => process.stdout.write(JSON.stringify(frame) + "\n"), ac.signal);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP + "\n");
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(VERSION + "\n");
    return;
  }

  // Pull options out, leaving positional [url, cmd, ...rest].
  let token: string | undefined = process.env.MCP_TOKEN;
  let relayPath: string | undefined = process.env.MCP_RELAY_PATH;
  let insecure = !!process.env.MCP_INSECURE;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--token") token = argv[++i];
    else if (a === "--relay") relayPath = argv[++i];
    else if (a === "--insecure") insecure = true;
    else positional.push(a);
  }

  const [url, cmd, ...rest] = positional;
  if (!url) {
    process.stderr.write(HELP + "\n");
    process.exit(2);
  }

  // Self-signed certs (local dev). Must be set before any fetch.
  if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const ep = endpoints(url, { token, relayPath });

  if (!cmd) return bridge(ep); // default: stdio MCP server bridge
  if (cmd === "watch") return watch(ep);
  return command(ep, cmd, rest);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
