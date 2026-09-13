#!/usr/bin/env node
// Gate: the extract engine's FieldKind vocabulary is IDENTICAL across ports.
//
// Every port's extract engine runs fixtures/extract-conformance/, whose schema.json `kind`
// values ARE this vocabulary. A port that adds or drops a kind changes what the shared corpus
// can express while every existing fixture keeps passing — so the drift is invisible by
// construction. It had already happened: C# carries a Decimal kind no other port has and no
// fixture exercises.
//
// Reads each port's real definition (not a duplicated list) and compares against
// fixtures/extract-conformance/expected-field-kinds.json. Deviations are allowed only when
// that file records them, with a reason, under `sanctionedDeviations`.
//
// Offline, no build, no network.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = "fixtures/extract-conformance/expected-field-kinds.json";

const expected = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));
const canonical = expected.canonical;

/**
 * Pull the member names out of one port's FieldKind definition.
 *
 * Deliberately per-language and deliberately narrow: each pattern matches that port's actual
 * declaration syntax and nothing else, so a definition that MOVED or was rewritten in a shape
 * this does not recognise fails loudly (unknown-shape) instead of silently reporting an empty
 * member set — which would read as "no drift" and is the one failure mode that would defeat
 * the whole gate.
 */
function membersOf(port, src) {
  switch (port) {
    case "java": {
      // public enum FieldKind { STRING, INT, ... }
      const m = src.match(/enum\s+FieldKind\s*\{([^}]*)\}/);
      if (!m) return null;
      return m[1].split(",").map((s) => s.trim()).filter(Boolean);
    }
    case "csharp": {
      // public enum FieldKind { String, Int, ... }  (PascalCase members)
      const m = src.match(/enum\s+FieldKind\s*\{([^}]*)\}/);
      if (!m) return null;
      return m[1].split(",").map((s) => s.trim()).filter(Boolean)
        .map((s) => s.toUpperCase());
    }
    case "typescript": {
      // export const FieldKind = { STRING: "STRING", ... } as const;
      const m = src.match(/const\s+FieldKind\s*=\s*\{([\s\S]*?)\}\s*as\s+const/);
      if (!m) return null;
      return [...m[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((x) => x[1]);
    }
    case "python": {
      // class FieldKind(Enum):\n    STRING = "STRING"\n ...
      const m = src.match(/class\s+FieldKind\s*\(\s*Enum\s*\)\s*:([\s\S]*?)(?=\n\S|\nclass\s)/);
      if (!m) return null;
      return [...m[1].matchAll(/^\s+([A-Z][A-Z0-9_]*)\s*=/gm)].map((x) => x[1]);
    }
    default:
      return null;
  }
}

const problems = [];

for (const [port, relPath] of Object.entries(expected.ports)) {
  let src;
  try {
    src = readFileSync(join(ROOT, relPath), "utf8");
  } catch {
    problems.push(`${port}: cannot read ${relPath} — did the definition move? Update ${MANIFEST}.`);
    continue;
  }

  const found = membersOf(port, src);
  if (found === null || found.length === 0) {
    problems.push(
      `${port}: could not parse a FieldKind definition out of ${relPath}. ` +
      `The declaration shape changed; fix the matcher in this script rather than ` +
      `letting it report an empty set.`);
    continue;
  }

  const allow = expected.sanctionedDeviations?.[port] ?? { extra: [], missing: [] };
  const allowedExtra = new Set(allow.extra ?? []);
  const allowedMissing = new Set(allow.missing ?? []);

  const extra = found.filter((k) => !canonical.includes(k) && !allowedExtra.has(k));
  const missing = canonical.filter((k) => !found.includes(k) && !allowedMissing.has(k));
  // A recorded deviation that is no longer TRUE is also drift: it means someone fixed (or
  // re-broke) the port and left the record claiming otherwise, and the next reader trusts it.
  const staleExtra = [...allowedExtra].filter((k) => !found.includes(k));
  const staleMissing = [...allowedMissing].filter((k) => found.includes(k));

  if (extra.length) problems.push(`${port}: unexpected FieldKind member(s): ${extra.join(", ")}`);
  if (missing.length) problems.push(`${port}: missing FieldKind member(s): ${missing.join(", ")}`);
  if (staleExtra.length)
    problems.push(`${port}: ${MANIFEST} records extra member(s) ${staleExtra.join(", ")} that are GONE — delete the stale sanctionedDeviations entry.`);
  if (staleMissing.length)
    problems.push(`${port}: ${MANIFEST} records missing member(s) ${staleMissing.join(", ")} that are now PRESENT — delete the stale sanctionedDeviations entry.`);
}

// Kotlin must NOT grow its own engine vocabulary: it drives the shared Java one.
if (expected.kotlinReusesJava) {
  let kotlinOwn = [];
  try {
    const out = (await import("node:child_process")).execFileSync(
      "git", ["grep", "-l", "-E", "(enum class|val)\\s+FieldKind", "--", "server/java/codegen-kotlin", "server/java/metadata-ktx"],
      { cwd: ROOT, encoding: "utf8" });
    kotlinOwn = out.split("\n").filter(Boolean);
  } catch { /* git grep exits 1 with no matches — the good case */ }
  if (kotlinOwn.length)
    problems.push(
      `kotlin: declares its own FieldKind in ${kotlinOwn.join(", ")}. Kotlin drives the shared ` +
      `Java extract engine; a second definition IS the drift this gate exists to catch.`);
}

if (problems.length) {
  console.error("extract FieldKind vocabulary drift:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\n  Canonical set (${MANIFEST}): ${canonical.join(", ")}`);
  console.error("  Every port's extract engine runs fixtures/extract-conformance/, so this");
  console.error("  vocabulary is a shared contract, not a per-port implementation detail.");
  process.exit(1);
}

const dev = Object.keys(expected.sanctionedDeviations ?? {});
console.log(
  `extract FieldKind: ${Object.keys(expected.ports).length} ports agree on ` +
  `[${canonical.join(", ")}]` +
  (dev.length ? ` (${dev.length} sanctioned deviation(s): ${dev.join(", ")})` : ""));
