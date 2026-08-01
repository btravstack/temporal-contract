import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WORKSPACE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Spec files permitted to mock the Temporal SDK. Every entry needs a reason
 * naming why the behavior is unreachable on a real time-skipping server.
 *
 * This list may only ever shrink. Adding to it requires the same scrutiny as
 * disabling a lint rule: the default answer is "move the test to the
 * `inprocess` tier" — see
 * docs/superpowers/specs/2026-08-01-mock-free-test-architecture-design.md
 */
const ALLOWLIST: Record<string, string> = {
  // Asserts the Vitest fixture plumbing itself, which must be observable
  // without paying for a real environment per assertion.
  "packages/testing/src/extension.spec.ts": "fixture plumbing, not Temporal semantics",
  "packages/testing/src/time-skipping.spec.ts": "fixture plumbing, not Temporal semantics",

  // Real SDK failure objects with faked transport — satisfies the rule.
  "packages/client/src/client.spec.ts": "constructs real SDK failures; fakes only transport",
  "packages/client/src/schedule.spec.ts": "constructs real SDK failures; fakes only transport",
};

// Flags a Temporal-SDK mock in three call shapes: the plain string-specifier
// form, its `doMock` sibling (same shape, deferred registration), and the
// type-safe form that wraps the specifier in an `import(...)` call — the one
// Vitest's own docs recommend, supported by the installed 4.1.10. A bare
// string-first check misses the latter two.
//
// NOTE for anyone editing this pattern: don't spell out a real matching
// example in a comment near this constant — this very file is itself walked
// by the corpus below, and a literal example would flag this file as an
// offender.
const SDK_MOCK = /vi\.(mock|doMock)\s*\(\s*(import\s*\(\s*)?["'`]@temporalio\//;

async function specFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith("."))
        continue;
      found.push(...(await specFiles(full)));
    } else if (entry.name.endsWith(".spec.ts")) {
      found.push(full);
    }
  }
  return found;
}

describe("no SDK mocks outside the allowlist", () => {
  it("keeps Temporal's real semantics under test", async () => {
    const files = await specFiles(WORKSPACE_ROOT);

    // Positive control on the directory walk itself: if the skip logic in
    // `specFiles` ever broadens (e.g. an overly greedy dotfile/name check)
    // and silently stops descending into real spec directories, `files`
    // could shrink toward empty and the loop below would pass vacuously —
    // "no offenders" because nothing was scanned, not because nothing
    // offends. The workspace has many more than 20 `*.spec.ts` files today;
    // guard against that regression.
    expect(files.length).toBeGreaterThan(20);

    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(WORKSPACE_ROOT, file);
      const source = await readFile(file, "utf8");
      if (SDK_MOCK.test(source) && !(rel in ALLOWLIST)) {
        offenders.push(rel);
      }
    }

    expect(
      offenders,
      `These specs mock the Temporal SDK without an allowlist entry. Mocking the SDK means ` +
        `the test asserts against a fake whose behavior we invented. Move the test to the ` +
        `"inprocess" tier (real time-skipping server) and assert the effect instead of the call.`,
    ).toEqual([]);
  });

  it("has no stale allowlist entries", async () => {
    const stale: string[] = [];
    for (const rel of Object.keys(ALLOWLIST)) {
      const source = await readFile(join(WORKSPACE_ROOT, rel), "utf8").catch(() => "");
      if (!SDK_MOCK.test(source)) stale.push(rel);
    }

    expect(stale, "Allowlisted specs that no longer mock the SDK — delete these entries.").toEqual(
      [],
    );
  });
});
