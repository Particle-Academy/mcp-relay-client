import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `connect.sh` is the documented fallback for agents that cannot register an MCP
 * server — which is most of them. Nothing covered it before, and it was broken
 * in three ways at once, each of which produced the same symptom: **silence**.
 *
 * 1. `await N | pretty` put the wait in a pipeline, so its non-zero exit was
 *    replaced by `pretty`'s zero. A failed call printed nothing and looked fine.
 * 2. `ARGS="${2:-{}}"` — bash ends the expansion at the first `}`, so the
 *    trailing brace was appended literally and every call WITH arguments posted
 *    `"arguments":{}}}}`, invalid JSON the host dropped without replying.
 * 3. `post()` discarded the HTTP status, so an expired token (401) surfaced
 *    only as an unexplained 15-second timeout.
 *
 * These tests deliberately use a bogus URL: everything asserted here must hold
 * WITHOUT a live session. That is the point — a usage error that needs a working
 * relay to report is what sent debugging in the wrong direction.
 */
const SCRIPT = resolve(__dirname, "../connect.sh");
const BOGUS = "https://ui.particle.academy/p?session=NOPE&token=NOPE";

/** Run connect.sh, capturing output and exit code rather than throwing. */
function run(...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe.skipIf(!existsSync(SCRIPT))("connect.sh", () => {
  it("is syntactically valid bash", () => {
    // The whole file is one `set -u` script; a syntax error anywhere breaks
    // every command, including the ones that need no network. `bash -n` exits
    // non-zero and execFileSync throws, which is the assertion.
    const check = execFileSync("bash", ["-n", SCRIPT], { encoding: "utf8", stdio: "pipe" });
    expect(check).toBe("");
  });

  it("rejects non-JSON arguments before making any network call", () => {
    const { code, out } = run(BOGUS, "call", "page_click", "not-json");

    expect(out).toContain("not valid JSON");
    expect(code).toBe(2);
    // Must NOT reach the relay — otherwise the caller is told their token is bad
    // when the real problem is their own arguments.
    expect(out).not.toContain("HTTP 401");
  });

  it("validates arguments on this machine's actual toolchain, jq or not", () => {
    // The check was originally gated on `command -v jq` alone, so on any machine
    // without jq it silently did nothing — and jq is absent far more often than
    // present. It now falls back to node, which `pretty()` already requires.
    //
    // Asserted against whichever of the two this machine actually has, and the
    // message says which, so a future failure reports the environment rather
    // than just "expected X to contain Y".
    const hasJq = (() => {
      try {
        execFileSync("bash", ["-c", "command -v jq"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();

    // Input deliberately free of braces and brackets: Git Bash on Windows
    // mangles those inside execFileSync argv, which fails the test for reasons
    // that have nothing to do with the script. Verified separately from a real
    // shell that `{oops` and `[1,2` are rejected too.
    const { out, code } = run(BOGUS, "call", "page_click", "definitely-not-json");

    expect(out, `validating with ${hasJq ? "jq" : "node (jq absent)"}`).toContain("not valid JSON");
    expect(code).toBe(2);
  });

  it("prints usage, not an unbound-variable error, when the tool name is missing", () => {
    // The EXIT trap killed $SSE_PID unguarded, so an early exit replaced the
    // usage message with a shell error from inside cleanup.
    const { code, out } = run(BOGUS, "call");

    expect(out).toContain("usage:");
    expect(out).not.toContain("unbound variable");
    expect(code).toBe(2);
  });

  it("reports WHY a call failed instead of exiting silently", () => {
    // The original returned 1 with no output whatsoever. An agent could not
    // distinguish a dead session from an unattached browser from a client bug.
    const { code, out } = run(BOGUS, "call", "page_describe", "{}");

    expect(out.trim()).not.toBe("");
    expect(out).toMatch(/error:/);
    expect(code).not.toBe(0);
  });

  it("names an expired or wrong token specifically", () => {
    const { out } = run(BOGUS, "call", "page_describe", "{}");

    // A bogus token is the single most likely cause of a stale session link, and
    // the relay says so with a 401 that used to be discarded into /dev/null.
    expect(out).toMatch(/401|token|session/i);
  });
});
