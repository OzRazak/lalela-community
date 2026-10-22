/* Amp kit · schema · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
// @auxo/amp-schema — zero-dependency validator for auxo-design.json.
// Hand-rolled (no ajv) on purpose: the lint package is zero-dep and reuses
// this same function, and the CLI must run with `node` and no install.
// Contract: { dial: 0|1|2|3, archetype: "A"|"B"|"C", soberZones: string[], brandNamespace: string }.

export const DIALS = [0, 1, 2, 3];
export const ARCHETYPES = ["A", "B", "C"];

/**
 * Validate a parsed auxo-design manifest object.
 * @param {unknown} manifest
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateManifest(manifest) {
  const errors = [];

  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["manifest must be a JSON object"] };
  }
  const m = /** @type {Record<string, unknown>} */ (manifest);

  // dial
  if (!("dial" in m)) {
    errors.push("dial is required");
  } else if (!Number.isInteger(m.dial) || !DIALS.includes(m.dial)) {
    errors.push(`dial must be one of ${DIALS.join("|")} (got ${JSON.stringify(m.dial)})`);
  }

  // archetype
  if (!("archetype" in m)) {
    errors.push("archetype is required");
  } else if (typeof m.archetype !== "string" || !ARCHETYPES.includes(m.archetype)) {
    errors.push(`archetype must be one of ${ARCHETYPES.join("|")} (got ${JSON.stringify(m.archetype)})`);
  }

  // soberZones
  if (!("soberZones" in m)) {
    errors.push("soberZones is required (use [] for none)");
  } else if (!Array.isArray(m.soberZones) || !m.soberZones.every((z) => typeof z === "string" && z.length > 0)) {
    errors.push("soberZones must be an array of non-empty path strings");
  }

  // brandNamespace
  if (!("brandNamespace" in m)) {
    errors.push("brandNamespace is required");
  } else if (typeof m.brandNamespace !== "string" || m.brandNamespace.trim().length === 0) {
    errors.push("brandNamespace must be a non-empty string");
  }

  // moments (optional) — opt out of scoreboard reporting (default true)
  if ("moments" in m && typeof m.moments !== "boolean") {
    errors.push(`moments must be a boolean (got ${JSON.stringify(m.moments)})`);
  }

  // sound (optional) — force the Amp Audio default on/off (default derived from dial)
  if ("sound" in m && typeof m.sound !== "boolean") {
    errors.push(`sound must be a boolean (got ${JSON.stringify(m.sound)})`);
  }

  // reject unknown top-level keys (catches typos like `dail`)
  const allowed = new Set(["dial", "archetype", "soberZones", "brandNamespace", "moments", "sound", "$schema"]);
  for (const key of Object.keys(m)) {
    if (!allowed.has(key)) errors.push(`unknown key "${key}"`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Parse + validate raw JSON text.
 * @param {string} text
 * @returns {{ valid: boolean, errors: string[], manifest?: object }}
 */
export function validateJson(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (err) {
    return { valid: false, errors: [`invalid JSON: ${err.message}`] };
  }
  return { ...validateManifest(manifest), manifest };
}
