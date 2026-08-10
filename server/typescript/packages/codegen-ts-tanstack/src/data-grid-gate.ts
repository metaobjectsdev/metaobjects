import type { MetaObject } from "@metaobjectsdev/metadata";
import { LAYOUT_SUBTYPE_DATA_GRID } from "@metaobjectsdev/metadata";
import type { GenContext } from "@metaobjectsdev/codegen-ts";

/** True when the entity declares (or inherits) at least one `layout.dataGrid`. */
export function hasDataGridLayout(entity: MetaObject): boolean {
  // layouts() is effective — own + inherited layouts (from extends:/super:).
  return entity.layouts().some((l) => l.subType === LAYOUT_SUBTYPE_DATA_GRID);
}

/**
 * Grid artifacts are opt-IN per entity: an entity produces one only when it declares
 * a `layout.dataGrid` child. That is intended — but nothing used to say so. An
 * adopter who wired `tanstackQuery() + tanstackGrid()` got `.hooks.ts` for every
 * entity and `.columns.tsx` for none, and reasonably concluded codegen was broken
 * (#287). The package description promising "hooks and column definitions"
 * unconditionally made it worse.
 *
 * So the run itself now says it, following the repo's tell-at-`meta gen`-time
 * precedent (#226 / #258) rather than a doc line that gets missed the same way this
 * one was. Warning only: the exit code is untouched, and `--dry-run` reports it too,
 * since generators run before the write phase branches.
 *
 * It fires ONLY when the generator emitted **nothing at all** — which is the reported
 * condition ("no columns file for ANY entity") and makes the note self-extinguishing:
 * declare one `layout.dataGrid` anywhere in the model and it goes quiet forever. A
 * 50-entity model with 3 grids therefore stays silent, because that author plainly
 * knows how grids work and a permanent 47-name nag is exactly the cry-wolf failure
 * that got the old `timestampMode` warning deleted from `runner.ts` rather than left
 * to fire forever.
 *
 * `passesOtherGates` is the generator's own filter MINUS the layout check, so the
 * named set is exactly "objects the layout gate — and nothing else — held back".
 * It needs no explicit `object.value` exclusion: a value is sourceless by
 * loader-enforced purity (ADR-0028), and `emitsInstanceArtifacts` now gates on a
 * declared source, so values never reach here. Filtering them by SUBTYPE would be
 * the persistability-from-subtype check #248 spent two releases eradicating.
 */
export function warnMissingDataGridLayout(
  ctx: GenContext,
  passesOtherGates: (entity: MetaObject) => boolean,
  artifact: string,
): void {
  const candidates = ctx.entities.filter(passesOtherGates);
  if (candidates.length === 0) return;
  if (candidates.some(hasDataGridLayout)) return;   // the model uses grids — say nothing
  ctx.warn(
    `no ${artifact} emitted for ${candidates.map((e) => e.name).join(", ")} — grid ` +
      `artifacts are opt-in per entity via a \`layout.dataGrid\` child, and no object in ` +
      `this model declares one. Add e.g. ` +
      `{"layout.dataGrid": {"name": "default", "@columns": ["id", "name"]}} to an entity ` +
      `to emit its grid.`,
  );
}
