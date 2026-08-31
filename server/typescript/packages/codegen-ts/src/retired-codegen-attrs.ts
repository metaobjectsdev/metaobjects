import type { MetaObject } from "@metaobjectsdev/metadata";
import { RETIRED_CODEGEN_ATTRS } from "./constants.js";

/**
 * `@emitRoutes` / `@emitTanstack` / `@emitForm` / `@emitGrid` / `@emitAngular` were read
 * off metadata by generator filters and were never registered metamodel vocabulary. Under
 * the strict loader — which is what `meta verify` runs — every one of them is
 * `ERR_UNKNOWN_ATTR`, while `meta gen` loads non-strict and honoured them. That is the
 * defect: an adopter who authored the documented opt-out got working suppression AND a red
 * `meta verify`, with nothing connecting the two.
 *
 * The reads are gone (see constants.ts for why registering them was refused rather than
 * the other way round). But a project can be sitting on a WORKING `@emitRoutes: false`
 * today, and deleting the read alone would start writing that suppressed file with no
 * explanation — a silent behaviour change on upgrade, which is the one outcome not open
 * to us. So the run says it.
 *
 * This follows the `layout.dataGrid` precedent (#287, data-grid-gate.ts) and the prompt
 * generator gate beside it: tell the adopter at `meta gen` time rather than in a doc line
 * that gets missed the same way the original one was. Warning only — the exit code is
 * untouched, and `--dry-run` reports it too, since generators run before the write phase
 * branches.
 *
 * It lives in the RUNNER, not in a generator, for two reasons. It is a model-level
 * observation, so it must fire exactly ONCE per run rather than once per generator that
 * happens to be wired; and the attribute is equally stale whether or not the generator it
 * used to suppress is wired at all, so a generator-local check would go quiet in exactly
 * the project that dropped the generator and kept the attribute.
 *
 * Self-extinguishing: removing the attribute from the metadata silences it forever. That
 * is also the fix, since the same edit is what makes `meta verify` pass.
 */
export function warnRetiredCodegenAttrs(
  entities: readonly MetaObject[],
  warn: (msg: string) => void,
): void {
  for (const { name, replacement } of RETIRED_CODEGEN_ATTRS) {
    // ADR-0039: resolving — an INHERITED flag suppressed emission exactly as an own one
    // did, so an own-only read here would leave the inheriting adopter unwarned while
    // their output silently changed. `hasAttr` rather than a value comparison: an
    // `@emitForm: true` was a no-op that still fails `meta verify`, so it is just as
    // stale as the `false` that did something.
    const carriers = entities.filter((e) => e.hasAttr(name));
    if (carriers.length === 0) continue;
    warn(
      `@${name} on ${carriers.map((e) => e.name).join(", ")} is no longer read by any ` +
        `generator — it was never registered metamodel vocabulary, so \`meta verify\` ` +
        `rejects it outright with ERR_UNKNOWN_ATTR. Decide per generator what you ` +
        `consume: ${replacement}. Remove the attribute to silence this.`,
    );
  }
}
