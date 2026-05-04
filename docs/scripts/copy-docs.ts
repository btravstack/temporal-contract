// These imports establish dependencies for knip detection and turbo build ordering.
// They must be kept in sync with the packages array below.
import "@temporal-contract/client";
import "@temporal-contract/contract";
import "@temporal-contract/testing/global-setup";
import "@temporal-contract/worker/activity";

import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsApiDir = join(__dirname, "..", "api");
const packagesDir = join(__dirname, "..", "..", "packages");

const packages = ["client", "contract", "testing", "worker"];

async function copyDocs(): Promise<void> {
  try {
    // Create api directory if it doesn't exist
    await mkdir(docsApiDir, { recursive: true });

    // Copy docs from each package
    for (const pkg of packages) {
      const sourcePath = join(packagesDir, pkg, "docs");
      const targetPath = join(docsApiDir, pkg);

      // Remove existing directory if it exists (to handle clean rebuilds)
      try {
        await rm(targetPath, { recursive: true });
      } catch {
        // Target doesn't exist, which is fine
      }

      try {
        await cp(sourcePath, targetPath, { recursive: true });
        console.log(`✓ Copied docs for @temporal-contract/${pkg}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`⚠ Could not copy docs for @temporal-contract/${pkg}:`, message);
      }
    }

    console.log("\n✅ All documentation copied successfully!");
  } catch (error) {
    console.error("❌ Error copying documentation:", error);
    process.exit(1);
  }
}

copyDocs();
