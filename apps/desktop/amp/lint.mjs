/* Amp kit · lint · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
// @auxo/amp-lint — zero-dependency Amp conformance check.
// Consumers run this in CI / their e2e harness. It fails (returns ok:false,
// and the CLI exits 1) on any of these Amp violations:
//   (a) a personality primitive imported inside a registered sober path
//   (b) a motion token missing its reduced-motion resolution
//   (c) a missing or invalid auxo-design.json
//   (d) a Spark expression state missing a dial resolution, or whose dial-0
//       resolution is not a static ink-on-yellow mark. Only checked when a
//       spark.tokens.json is present (the marks package / a marks consumer).
// Pure Node, no npm dependencies, no build step. Copy-distributable.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ── Personality signals (check a) ──────────────────────────────────────────
// Import SOURCES that only belong at dial ≥1 (the Spark, celebration marks,
// personality primitives). EmptyState / SoberZone / tokens are sober-safe and
// intentionally NOT listed.
const PERSONALITY_SOURCES = [
  "@auxo/amp-marks",
  "@auxo/amp/marks",
  "@auxo/amp-primitives/celebration",
];
// Named symbols that carry personality regardless of the source package.
const PERSONALITY_SYMBOLS = ["Spark", "Milestone", "CelebrateBurst", "Confetti"];

// ── Spark marks contract (check d) ──────────────────────────────────────────
// Every Spark expression state must declare all four dial resolutions, and its
// dial-0 resolution must be a static ink-on-yellow mark (identical to the
// prefers-reduced-motion resolution — motion degrades to art, never breaks).
const SPARK_STATES = [
  "idle-breathe", "blink", "dart", "celebrate-burst", "think", "shy", "point",
];
const SPARK_DIALS = ["0", "1", "2", "3"];

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", ".turbo", "dist", "build", "out", "coverage", ".vercel",
]);

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (IGNORE_DIRS.has(name)) continue;
      walk(full, acc);
    } else {
      const dot = name.lastIndexOf(".");
      if (dot >= 0 && SOURCE_EXT.has(name.slice(dot))) acc.push(full);
    }
  }
  return acc;
}

function firstExisting(root, candidates) {
  for (const c of candidates) {
    const p = join(root, c);
    if (existsSync(p)) return p;
  }
  return null;
}

async function loadValidator() {
  // Prefer the co-located schema validator (flat `amp/` copy layout), then the
  // monorepo layout; fall back to a built-in minimal check so lint stays
  // self-contained if the schema file was not distributed alongside.
  for (const rel of ["./validate.mjs", "../../schema/src/validate.mjs"]) {
    try {
      const mod = await import(new URL(rel, import.meta.url).href);
      if (mod?.validateJson) return mod.validateJson;
    } catch {
      /* try next */
    }
  }
  return (text) => {
    let m;
    try {
      m = JSON.parse(text);
    } catch (e) {
      return { valid: false, errors: [`invalid JSON: ${e.message}`] };
    }
    const errors = [];
    if (![0, 1, 2, 3].includes(m?.dial)) errors.push("dial must be 0|1|2|3");
    if (!["A", "B", "C"].includes(m?.archetype)) errors.push("archetype must be A|B|C");
    if (!Array.isArray(m?.soberZones)) errors.push("soberZones must be an array");
    if (typeof m?.brandNamespace !== "string" || !m.brandNamespace.trim())
      errors.push("brandNamespace must be a non-empty string");
    return { valid: errors.length === 0, errors, manifest: m };
  };
}

/**
 * Run the Amp lint over a project.
 * @param {{ root?: string, manifestPath?: string, tokensPath?: string, sparkPath?: string }} [opts]
 * @returns {Promise<{ ok: boolean, errors: string[], warnings: string[] }>}
 */
export async function lint(opts = {}) {
  const root = opts.root ?? process.cwd();
  const errors = [];
  const warnings = [];

  // (c) manifest present + valid
  const manifestPath =
    opts.manifestPath ??
    firstExisting(root, ["auxo-design.json", "amp/auxo-design.json", "src/auxo-design.json"]);
  let manifest = null;
  if (!manifestPath || !existsSync(manifestPath)) {
    errors.push("(c) missing auxo-design.json — every Amp app must declare one");
  } else {
    const validateJson = await loadValidator();
    const res = validateJson(readFileSync(manifestPath, "utf8"));
    if (!res.valid) {
      for (const e of res.errors) errors.push(`(c) invalid auxo-design.json: ${e}`);
    } else {
      manifest = res.manifest;
    }
  }

  // (b) motion tokens each carry a reduced-motion resolution
  const tokensPath =
    opts.tokensPath ??
    firstExisting(root, ["amp/tokens.json", "packages/tokens/tokens.json", "tokens.json"]);
  if (tokensPath && existsSync(tokensPath)) {
    try {
      const tk = JSON.parse(readFileSync(tokensPath, "utf8"));
      const motion = tk?.motion ?? {};
      for (const [name, token] of Object.entries(motion)) {
        const r = token?.reduced;
        if (!r || typeof r.durationMs !== "number" || typeof r.easing !== "string") {
          errors.push(`(b) motion token "${name}" is missing a reduced-motion resolution`);
        }
      }
    } catch (e) {
      errors.push(`(b) could not parse motion tokens at ${tokensPath}: ${e.message}`);
    }
  } else {
    warnings.push("(b) no tokens.json found to check motion reduced-motion resolutions");
  }

  // (a) no personality primitives imported inside sober paths
  const soberZones = (manifest?.soberZones ?? []).map((z) => z.replace(/^[./]+/, "").replace(/\/+$/, ""));
  if (soberZones.length > 0) {
    const files = walk(root);
    for (const file of files) {
      const rel = relative(root, file);
      const segments = rel.split(sep);
      const inSober = soberZones.some((z) =>
        z.split("/").filter(Boolean).every((seg) => segments.includes(seg)),
      );
      if (!inSober) continue;
      const src = readFileSync(file, "utf8");
      for (const bad of PERSONALITY_SOURCES) {
        if (src.includes(`"${bad}"`) || src.includes(`'${bad}'`)) {
          errors.push(`(a) sober path imports personality source "${bad}": ${rel}`);
        }
      }
      const importLines = src.match(/import[\s\S]*?from\s+['"]@auxo\/amp[^'"]*['"]/g) ?? [];
      for (const line of importLines) {
        for (const sym of PERSONALITY_SYMBOLS) {
          if (new RegExp(`\\b${sym}\\b`).test(line)) {
            errors.push(`(a) sober path imports personality primitive "${sym}": ${rel}`);
          }
        }
      }
    }
  }

  // (d) Spark marks contract — only when a spark.tokens.json is present.
  const sparkPath =
    opts.sparkPath ??
    firstExisting(root, [
      "amp/marks/spark.tokens.json",
      "packages/marks/spark.tokens.json",
      "spark.tokens.json",
    ]);
  if (sparkPath && existsSync(sparkPath)) {
    try {
      const spark = JSON.parse(readFileSync(sparkPath, "utf8"));
      const states = spark?.states ?? {};
      for (const name of SPARK_STATES) {
        const st = states[name];
        if (!st || typeof st !== "object") {
          errors.push(`(d) Spark marks missing expression state "${name}"`);
          continue;
        }
        const res = st.resolutions ?? {};
        for (const dial of SPARK_DIALS) {
          if (!res[dial] || typeof res[dial] !== "object") {
            errors.push(`(d) Spark state "${name}" is missing its dial-${dial} resolution`);
          }
        }
        if (res["0"] && res["0"].static !== true) {
          errors.push(`(d) Spark state "${name}" dial-0 must be a static ink-on-yellow mark (static:true)`);
        }
      }
    } catch (e) {
      errors.push(`(d) could not parse Spark marks at ${sparkPath}: ${e.message}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
