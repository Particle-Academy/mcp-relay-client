# Changelog

All notable changes to `mcp-relay-client` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Pre-1.0:** breaking changes land in MINOR releases. Until 1.0 the minor
> number is not a compatibility promise — read the entry, not the version.

> This file starts here. Earlier releases predate it and were never written up;
> `git log` is the record for those.

## [Unreleased]

### Fixed

- **The client advertised 0.1.0 while the package shipped as 0.3.0.** A literal with nothing comparing it to `package.json`. It now reads `package.json` at runtime; `version.test.ts` fails if a literal returns.


## [0.3.0] — 2026-08-09

### Fixed

- **All four single-file clients were sending a token that had been decoded and
  never re-encoded.** A token containing `+` arrived at the server as a space
  and one containing `/` as a path separator, so authentication failed for any
  session whose token happened to include either. `connect.go`, `connect.py`
  and `connect.ts` all had it; `connect.sh` did not, by accident — it extracts
  the raw value with a regex instead of parsing.

  This was found by the new conformance runner, and it is not in the nine
  divergences the polyglot plan had already catalogued. It was a tenth.

- **The four clients defaulted to the `whiteboard-share` relay mount**, which
  the library stopped using. It kept working only because the server keeps that
  prefix as a back-compat alias — which is exactly why a wrong default survived
  unnoticed. All four now default to `agent-relay`.

### Added

- **`conformance/endpoints.json`** — one shared fixture table for endpoint
  resolution, and **`scripts/conformance-clients.mjs`**, which asserts every
  single-file client against it. `npm test` covers the library's half.

  CI now installs Python and Go and runs both halves on every push. It
  previously ran neither: `connect.go` was never compiled, `connect.py` never
  imported, `connect.sh` never executed — five implementations of one contract
  with a test suite that exercised one.

  A runtime that is not installed is reported as a SKIP and, if every client is
  skipped, fails the run. A missing toolchain must not read as a pass; that is
  the failure mode where `skipIf(!HAS_PHP)` turns a runner without PHP into a
  green build with zero coverage.

- Each client gained a `--print-endpoints` mode — the seam the conformance
  runner drives. It is also the smallest thing that makes a shell script
  testable at all.

- The `poll` endpoint is now resolved by every client. Cloudflare's HTTP/3 edge
  resets SSE, so a client that only knows about `events` silently receives
  nothing from behind it. **Resolving the URL is not the same as using it** —
  the long-poll receive loop is still only in the library, and is the remaining
  half of that fix.


## 0.2.0 — 2026-08-07

### Changed

- **BREAKING — Node 18 is no longer supported.** `engines.node` moves from `>=18` to `>=22`.

  **What you must do:** on Node 22 or newer, nothing. Note npm only *warns* on an `engines` mismatch while **pnpm fails the install**, so this surfaces differently depending on your package manager. Node 18 is end-of-life and 20 is maintenance-only.

### Why

These are the kit 0.5 platform floors, applied across every package at once so a consumer never has to resolve a mix. **No API changed, nothing was removed, nothing was renamed** — only what the package requires.


## 0.1.3 — 2026-07-15

### Fixed

- cancel relay calls on human takeover

## 0.1.2 — 2026-07-15

### Fixed

- make relay client adaptive and race-free

## 0.1.1 — 2026-06-16

- Maintenance only (2 internal commits).

## 0.1.0 — 2026-06-16

### Added

- npx CLI — zero-install MCP client + stdio bridge
- super-lite single-file MCP relay clients (bash / python / ts / go)

### Changed

- default relay path → agent-relay

### Fixed

- **`connect.sh` could not invoke a single tool, and said nothing about it.**
  `tools` worked, so a session looked connected; every `call` then exited after
  15 seconds with **no output at all**. An agent had no way to tell a dead
  session from an unattached browser from a client bug. Four separate defects,
  all producing the same silence (#1):

  - **The failure was piped away.** `await N | pretty` put the wait in a
    pipeline, so its non-zero exit was replaced by `pretty`'s zero — a failed
    call printed nothing and looked like success. The wait is now captured
    before formatting.
  - **`ARGS="${2:-{}}"` built invalid JSON.** Bash ends the expansion at the
    first `}`, so the trailing brace was appended literally and every call
    *with* arguments posted `"arguments":{}}}}`. The host dropped it without
    replying — and that is the form the co-browse prompt documents.
  - **HTTP status was discarded.** `post()` sent to `/dev/null`, so an expired
    token (401) or a bad session id (404) surfaced only as an unexplained
    timeout. Those now say exactly that.
  - **Argument validation ran too late and usually not at all.** It was gated on
    `command -v jq`, silently doing nothing wherever jq is absent — which is
    most machines — and it sat *after* the handshake, so a typo in the arguments
    was reported as a token problem. It now runs before any network call and
    falls back to node.

- **A timed-out wait now explains itself**, including the case that actually
  matters: the stream is alive but nothing answers, which almost always means no
  browser is attached to the session. Tool calls are answered by the page, not
  by the relay — which is exactly why `tools` can succeed while every `call`
  hangs. `MCP_WAIT_TICKS` raises the 15s ceiling for genuinely slow tools.

- **An early exit no longer dies inside its own cleanup.** The `EXIT` trap killed
  `$SSE_PID` unguarded, so a usage error printed a shell unbound-variable error
  instead of the usage message.

### Added

- Tests for `connect.sh`. There were none — the suite covered only endpoint
  parsing, which is why a fallback that could not make a single successful call
  shipped and stayed broken. All of them run without a live session.
