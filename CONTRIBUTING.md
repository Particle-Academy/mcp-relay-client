# Contributing to mcp-relay-client

Notes for anyone, human or agent, working ON this package's code. How to USE the
package is in [AGENTS.md](./AGENTS.md); what it is, is in [README.md](./README.md).
`CLAUDE.md` is a symlink to this file, so Claude Code reads these notes when it
works in this repo.

## Build and test

```bash
npm install
npm run build        # tsup
npm run lint         # tsc --noEmit
npm test             # vitest run
npm run conformance  # every single-file client against the shared table
```

## Five implementations, one table

This repo ships five implementations of one contract: `src/endpoints.ts` plus
`connect.sh`, `connect.py`, `connect.go` and `connect.ts`. They were
hand-transliterated in one commit and then diverged, because nothing asserted
them against a common table. `conformance/endpoints.json` is that table:

- `tests/conformance.test.ts` asserts the TypeScript library against it.
- `scripts/conformance-clients.mjs` runs each client's `--print-endpoints` mode
  and compares the JSON. A runtime that is not installed is SKIPPED and
  reported, never counted as a pass. It never uses `shell: true`, because the
  Windows shell re-parses `&` inside a URL.

Adding a language means adding a row to that script, never a second table. A
change to endpoint resolution (relay path, the `poll` leg, token handling) has
to land in all five implementations and in the table together.

## Changelog

Update `CHANGELOG.md` (`[Unreleased]`) in the same commit as the change.
