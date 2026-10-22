#!/usr/bin/env node
/* Amp kit · lint · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
// amp-lint — CLI wrapper. Runs the Amp conformance check against a project.
// Usage: node packages/lint/bin/amp-lint.mjs [<projectRoot>]
//        node amp/amp-lint.mjs [<projectRoot>]   (shadcn-style flat copy)
// Exit: 0 clean, 1 on any violation (CI/harness contract).
//
// Resolve lint.mjs from whichever layout this bin was copied into: the flat
// `amp/` source-copy layout puts lint.mjs beside this file (./lint.mjs); the
// in-repo monorepo layout keeps it at ../src/lint.mjs. Try co-located first,
// then the monorepo path, so the CLI runs in both eras without an alias.
async function loadLint() {
  for (const rel of ["./lint.mjs", "../src/lint.mjs"]) {
    try {
      const mod = await import(new URL(rel, import.meta.url).href);
      if (mod?.lint) return mod.lint;
    } catch {
      /* try next layout */
    }
  }
  throw new Error("amp-lint: could not locate lint.mjs (looked for ./lint.mjs and ../src/lint.mjs)");
}
const lint = await loadLint();

const root = process.argv.slice(2).find((a) => !a.startsWith("-")) ?? process.cwd();
const { ok, errors, warnings } = await lint({ root });

for (const w of warnings) console.warn(`  ⚠ ${w}`);
if (ok) {
  console.log("  ✓ amp-lint: no violations");
} else {
  console.error("  ✗ amp-lint: violations found");
  for (const e of errors) console.error(`      ${e}`);
}
console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(ok ? 0 : 1);
