#!/usr/bin/env node
/**
 * Assert every single-file client against conformance/endpoints.json.
 *
 * This repo ships FIVE implementations of one contract — `src/endpoints.ts`
 * plus connect.sh / .py / .go / .ts. They were hand-transliterated in one
 * commit and then diverged, because CI only ever ran `npm install/lint/test/
 * build`: connect.go was never compiled, connect.py never imported, connect.sh
 * never executed. All four ended up defaulting to a stale relay path, and none
 * knew about the CDN-safe `poll` leg — so behind Cloudflare, whose HTTP/3 edge
 * resets SSE, they silently received nothing.
 *
 * The library half of the table is asserted by tests/conformance.test.ts. This
 * script is the other half: it runs each client's `--print-endpoints` mode and
 * compares the JSON, so adding a language means adding a row here, never a
 * second table.
 *
 * A runtime that is not installed is SKIPPED and reported — a missing `go`
 * must not read as a pass. That is the exact failure mode the polyglot plan
 * documents in holy-sheet's parity suite, where `skipIf(!HAS_PHP)` turns a CI
 * runner with no PHP into a green build with zero cross-engine coverage.
 */
import { execFileSync } from "node:child_process";

/**
 * Never `shell: true`. On Windows the shell re-parses `&` inside a URL as a
 * command separator, so every fixture whose query string has two parameters
 * turns into a mangled command — which looks exactly like a client that
 * resolved the wrong endpoint rather than like a broken harness.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = JSON.parse(readFileSync(resolve(root, "conformance/endpoints.json"), "utf8"));

/** Each client, and how to ask it to resolve a URL. */
const CLIENTS = [
  { name: "connect.sh", probe: ["bash", "--version"], run: (url) => ["bash", ["connect.sh", url, "--print-endpoints"]] },
  { name: "connect.py", probe: ["python", "--version"], run: (url) => ["python", ["connect.py", url, "--print-endpoints"]] },
  { name: "connect.go", probe: ["go", "version"], run: (url) => ["go", ["run", "./connect.go", url, "--print-endpoints"]] },
    // Invoked as `node node_modules/tsx/dist/cli.mjs`, not `npx tsx`. Node 18+
  // refuses to spawn a .cmd shim without a shell (CVE-2024-27980), and turning
  // the shell on would re-parse the `&` inside every fixture URL. tsx is a
  // devDependency so CI does not fetch it at run time either.
  {
    name: "connect.ts",
    probe: ["node", ["--version"]],
    run: (url) => ["node", ["node_modules/tsx/dist/cli.mjs", "connect.ts", url, "--print-endpoints"]],
  },
];

const available = (probe) => {
  try {
    const [cmd, args] = Array.isArray(probe[1]) ? probe : [probe[0], probe.slice(1)];
    execFileSync(cmd, args, { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

let failures = 0;
const skipped = [];

for (const client of CLIENTS) {
  if (!available(client.probe)) {
    skipped.push(client.name);
    continue;
  }

  for (const c of fixtures.cases) {
    // The clients take the relay path from MCP_RELAY_PATH, not a flag.
    const env = { ...process.env };
    if (c.options?.relayPath) env.MCP_RELAY_PATH = c.options.relayPath;

    const [cmd, args] = client.run(c.url);
    let actual;
    try {
      const out = execFileSync(cmd, args, { cwd: root, env, encoding: "utf8" });
      actual = JSON.parse(out.trim().split("\n").pop());
    } catch (e) {
      console.error(`FAIL ${client.name} — ${c.name}: ${e.message.split("\n")[0]}`);
      failures++;
      continue;
    }

    for (const key of ["session", "inbox", "events", "poll"]) {
      if (actual[key] !== c.expect[key]) {
        console.error(`FAIL ${client.name} — ${c.name}\n  ${key}\n    expected ${c.expect[key]}\n    actual   ${actual[key]}`);
        failures++;
      }
    }
  }
  console.log(`ok   ${client.name} — ${fixtures.cases.length} cases`);
}

if (skipped.length) {
  // Loud, and on stderr: a skipped runtime is missing coverage, not a pass.
  console.error(`\nSKIPPED (runtime not installed): ${skipped.join(", ")}`);
  console.error("These clients were NOT verified in this run.");
}

if (failures) {
  console.error(`\n${failures} conformance failure(s).`);
  process.exit(1);
}

if (skipped.length === CLIENTS.length) {
  console.error("\nNo client could be run at all — refusing to report success.");
  process.exit(1);
}

console.log(`\nAll runnable clients satisfy conformance/endpoints.json.`);
