/**
 * Copy src/templates into dist/templates.
 *
 * Replaces the previous `xcopy` invocation, which is cmd.exe-only and made the
 * build fail on the Linux CI runner.
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "templates");
const dest = join(root, "dist", "templates");

await mkdir(dirname(dest), { recursive: true });
await rm(dest, { recursive: true, force: true });
await cp(src, dest, { recursive: true });

console.log(`Copied ${src} -> ${dest}`);
