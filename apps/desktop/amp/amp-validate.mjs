#!/usr/bin/env node
/* Amp kit · schema · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
// amp-validate — validate one or more auxo-design.json manifests.
// Usage:
//   node packages/schema/bin/validate.mjs <path> [<path> ...]
//   node packages/schema/bin/validate.mjs            # defaults to ./auxo-design.json
// Exit code: 0 if every file is valid, 1 otherwise (CI/harness contract).
import { readFileSync } from "node:fs";

// Resolve validate.mjs from whichever layout this bin was copied into: the flat
// `amp/` source-copy layout puts validate.mjs beside this file (./validate.mjs);
// the in-repo monorepo layout keeps it at ../src/validate.mjs. Try co-located
// first, then the monorepo path — so the CLI runs in both eras without an alias
// (mirrors the lint bin's loadLint resolver). Unlike the lint bin, this file is
// itself named validate.mjs, so ./validate.mjs can resolve to THIS bin in the
// monorepo layout — skip a self-URL to avoid a self-import deadlock (top-level
// await never settling).
async function loadValidator() {
  const self = import.meta.url;
  for (const rel of ["./validate.mjs", "../src/validate.mjs"]) {
    const url = new URL(rel, import.meta.url).href;
    if (url === self) continue; // never import ourselves
    try {
      const mod = await import(url);
      if (mod?.validateJson) return mod.validateJson;
    } catch {
      /* try next layout */
    }
  }
  throw new Error("amp-validate: could not locate validate.mjs (looked for ./validate.mjs and ../src/validate.mjs)");
}
const validateJson = await loadValidator();

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const files = args.length > 0 ? args : ["auxo-design.json"];

let failed = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`  ✗ ${file}\n      cannot read: ${err.message}`);
    failed++;
    continue;
  }
  const { valid, errors } = validateJson(text);
  if (valid) {
    console.log(`  ✓ ${file}`);
  } else {
    console.error(`  ✗ ${file}`);
    for (const e of errors) console.error(`      ${e}`);
    failed++;
  }
}

console.log(`\n${files.length - failed} valid, ${failed} invalid`);
process.exit(failed > 0 ? 1 : 0);
