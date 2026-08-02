import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WORKSPACE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Workspace-relative path in POSIX form, whatever the host separator is. See
 * `no-sdk-mocks.spec.ts`'s identical helper for the Windows rationale.
 */
function workspaceRelative(absolutePath: string): string {
  return relative(WORKSPACE_ROOT, absolutePath).split(sep).join("/");
}

/**
 * `*.inprocess.spec.ts` files permitted to contain a test that does not call
 * `testRig(`. Every entry needs a reason.
 *
 * This list may only ever shrink. A hand-rolled `TypedWorker.create` +
 * `TypedClient.create` pair (the pattern this rejects) silently gets no
 * replay coverage — exactly the rot `testRig`'s `onTestFinished` hook exists
 * to prevent — so an unlisted test without `testRig(` fails the guard
 * instead of quietly shipping uncovered.
 */
const ALLOWLIST: Record<string, string> = {
  "packages/worker/src/__tests__/registration.inprocess.spec.ts":
    "every test here must pass workflowsPath directly to TypedWorker.create — testRig's " +
    "RigOptions only accepts a prebuilt bundle, which always skips verifyWorkflowRegistration " +
    "(see the option's JSDoc), silently exempting the very check this file exists to exercise.",
  "packages/worker/src/__tests__/time-skipping.inprocess.spec.ts":
    "4 of its 5 tests build the worker/client pair by hand: 2 assert on the TypedWorker.create " +
    "/ TypedClient.create Result itself (Ok/Defect), which testRig's `.get()`-unwrapping " +
    "helper hides; 2 need `interceptors` / arbitrary WorkerOptions passthrough that RigOptions " +
    "does not expose.",
};

async function inprocessSpecFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith("."))
        continue;
      found.push(...(await inprocessSpecFiles(full)));
    } else if (entry.name.endsWith(".inprocess.spec.ts")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Matches a top-level test declaration in any of Vitest's spellings — `it(`,
 * `test(`, and every modifier chain (`it.each`, `it.concurrent`, `it.skip`,
 * `test.only`, …).
 *
 * Deliberately broader than `^\s*it\(`. A narrower pattern makes this guard
 * fail *open*: a file written entirely with `test(` or `it.each(` yields zero
 * blocks, the loop below never runs, and the file passes while enforcing
 * nothing. The corpus-level block assertion is the second net for that.
 *
 * `\b` keeps `itemCount` / `testEnv` from matching.
 */
const TEST_START = /^\s*(?:it|test)\b/;

/**
 * Strip comments before looking for `testRig(`. Without this, a block that
 * merely *mentions* the rig in prose — "// migrated off testRig(...)" —
 * satisfies the check without calling it, which is the same fail-open shape
 * the pattern above guards against.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Split a spec file's source into one chunk per `it(` block, each running
 * from its `it(` line to the line before the next one (or EOF). Line-based
 * rather than brace-balanced: every file in this corpus opens tests at
 * `^\s*it\(`, and slicing on that is enough to attribute a `testRig(` call
 * (or its absence) to the right test without a full parser.
 */
function testBlocks(source: string): string[] {
  const lines = source.split("\n");
  const starts = lines.reduce<number[]>((acc, line, index) => {
    if (TEST_START.test(line)) acc.push(index);
    return acc;
  }, []);
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : lines.length;
    return lines.slice(start, end).join("\n");
  });
}

/** Pulls the `it("...")` description out of a test block, for readable offender messages. */
function testDescription(block: string): string {
  // Mirrors TEST_START's breadth — a `test(` or `it.each(` offender should be
  // named in the failure, not reported as "(description not found)".
  const match = /(?:it|test)\b[^(]*\(\s*["'`]([^"'`]*)["'`]/.exec(block);
  return match?.[1] ?? "(description not found)";
}

describe("every in-process test uses the rig", () => {
  it("keeps replay coverage from silently regressing to zero for a new test", async () => {
    const files = await inprocessSpecFiles(WORKSPACE_ROOT);

    // Positive control on the directory walk — see `no-sdk-mocks.spec.ts`'s
    // identical rationale: an empty (or near-empty) `files` would make the
    // loop below pass vacuously. The workspace has well over 10
    // `*.inprocess.spec.ts` files today.
    expect(files.length).toBeGreaterThan(10);

    // Second, block-level positive control. The file count above proves the
    // corpus walk found files; it does NOT prove `testBlocks` found tests
    // inside them. If TEST_START ever stops matching this repo's spelling,
    // every file yields zero blocks and the offender loop passes while
    // checking nothing — the precise fail-open this guard exists to prevent.
    let totalBlocks = 0;

    const offenders: string[] = [];

    for (const file of files) {
      const rel = workspaceRelative(file);
      if (rel in ALLOWLIST) continue;

      const source = await readFile(file, "utf8");
      const blocks = testBlocks(source);
      totalBlocks += blocks.length;
      for (const block of blocks) {
        if (!stripComments(block).includes("testRig(")) {
          offenders.push(`${rel}: "${testDescription(block)}"`);
        }
      }
    }

    // The tier has ~59 tests; anything near zero means TEST_START stopped
    // matching, not that the tests vanished.
    expect(totalBlocks).toBeGreaterThan(40);

    expect(
      offenders,
      `These in-process tests don't call testRig(, so their executions get no replay-determinism ` +
        `coverage. Either use testRig (see any other *.inprocess.spec.ts) or, if the rig genuinely ` +
        `can't cover this case, add a reason-carrying entry to this file's ALLOWLIST.`,
    ).toEqual([]);
  });

  it("has no stale allowlist entries", async () => {
    const stale: string[] = [];
    for (const rel of Object.keys(ALLOWLIST)) {
      const source = await readFile(join(WORKSPACE_ROOT, rel), "utf8").catch(() => "");
      const stillOffRig = testBlocks(source).some(
        (block) => !stripComments(block).includes("testRig("),
      );
      if (!stillOffRig) stale.push(rel);
    }

    expect(
      stale,
      "Allowlisted files where every test now calls testRig( — delete these entries.",
    ).toEqual([]);
  });
});
