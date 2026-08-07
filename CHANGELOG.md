# Changelog

All notable changes to `mcp-relay-client` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Pre-1.0:** breaking changes land in MINOR releases. Until 1.0 the minor
> number is not a compatibility promise — read the entry, not the version.

> This file starts here. Earlier releases predate it and were never written up;
> `git log` is the record for those.

## [Unreleased]

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
