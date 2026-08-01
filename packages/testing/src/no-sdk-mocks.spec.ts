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

  // --- Migration debt. Each entry is deleted by its migration task. ---
  "packages/worker/src/continue-as-new.spec.ts": "TODO Task 6",
  "packages/worker/src/wire-format.spec.ts": "TODO Task 7",
  "packages/worker/src/workflow-errors.spec.ts": "TODO Task 8",
  "packages/worker/src/worker.spec.ts": "TODO Task 9",

  // Real SDK failure objects with faked transport — satisfies the rule.
  "packages/client/src/client.spec.ts": "constructs real SDK failures; fakes only transport",
  "packages/client/src/schedule.spec.ts": "constructs real SDK failures; fakes only transport",
};

const SDK_MOCK = /vi\.mock\(\s*["'`]@temporalio\//;

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
