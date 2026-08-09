import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { endpoints } from "../src/endpoints.js";

type Case = {
  name: string;
  url: string;
  options?: { relayPath?: string; token?: string };
  expect: { session: string; inbox: string; events: string; poll: string };
};
type ErrorCase = { name: string; url: string; expectErrorContains: string };

const fixtures = JSON.parse(
  readFileSync(new URL("../conformance/endpoints.json", import.meta.url), "utf8"),
) as { cases: Case[]; errors: ErrorCase[]; defaults: { relayPath: string } };

/**
 * The TypeScript half of the shared conformance table.
 *
 * This repo ships FIVE implementations of one contract — `src/endpoints.ts` plus
 * `connect.sh`, `connect.py`, `connect.go` and `connect.ts`. They were
 * hand-transliterated in a single commit and then diverged, because nothing
 * asserted them against a common table and CI only ever ran the TypeScript.
 *
 * The policy the polyglot plan settles on, and the reason this file exists: N
 * implementations of one contract are acceptable if and only if a shared fixture
 * table is asserted by EVERY implementation, in its own CI, on every push.
 * Anything less is a transliteration with a README.
 *
 * `scripts/conformance-clients.mjs` runs the same table against the four
 * single-file clients. This file covers the library.
 */
describe("conformance/endpoints.json — TypeScript library", () => {
  it("has fixtures to run", () => {
    // Without this, a fixture file that failed to parse into cases would make
    // every `it.each` below vanish and the suite pass with zero coverage.
    expect(fixtures.cases.length).toBeGreaterThan(4);
    expect(fixtures.errors.length).toBeGreaterThan(0);
  });

  it.each(fixtures.cases)("$name", (c) => {
    const ep = endpoints(c.url, c.options ?? {});

    expect(ep.session).toBe(c.expect.session);
    expect(ep.inbox).toBe(c.expect.inbox);
    expect(ep.events).toBe(c.expect.events);
    expect(ep.poll).toBe(c.expect.poll);
  });

  it.each(fixtures.errors)("$name", (c) => {
    expect(() => endpoints(c.url)).toThrow(new RegExp(c.expectErrorContains, "i"));
  });

  it("resolves the documented default relay path", () => {
    // The single-file clients each hardcoded `whiteboard-share` instead. It kept
    // working because the server keeps that prefix as a back-compat alias —
    // which is precisely why a wrong default survived unnoticed.
    const ep = endpoints("https://x.test/?session=S&token=T");

    expect(ep.inbox).toContain(`/${fixtures.defaults.relayPath}/`);
  });
});
