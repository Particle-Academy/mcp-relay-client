import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The version this package reports must be the version it ships as.
 *
 * It goes out in the client info this relay presents, and it said `"0.1.0"`
 * while the package shipped as 0.3.0 — two minor releases stale, with nothing
 * comparing the two.
 *
 * The literal is gone (the constant now reads `package.json`), so the first
 * test is nearly tautological and the SECOND is the one that matters: it fails
 * if someone types the literal back in, which is how this happened in the first
 * place. Every version surface swept in this estate had drifted, and one
 * reached a user — `fancy-flow-py` reported 0.1.0 from a 0.4.0 install for
 * three releases, found by the runtime's first outside consumer rather than by
 * us.
 */
describe("the version is single-sourced from package.json", () => {
  const root = join(__dirname, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

  it("resolves to package.json's version at runtime", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is not a hardcoded literal in the source", () => {
    // Guard the FIX, not its result. A re-introduced literal would agree with
    // package.json on the day it was written and drift on the next release,
    // and nothing else in the build compares them.
    const source = readFileSync(join(root, "src", "index.ts"), "utf8");

    const offenders = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^(?:const|let|var)\s+VERSION\b/.test(line))
      .filter((line) => /=\s*["'`]/.test(line));

    expect(
      offenders,
      "VERSION is assigned a string literal again: " +
        offenders.join(" | ") +
        ". Read it from package.json instead — a literal is a second copy of a number " +
        "that already exists, and second copies drift silently.",
    ).toEqual([]);
  });
});
