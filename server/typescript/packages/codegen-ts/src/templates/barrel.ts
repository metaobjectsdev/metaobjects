// Barrel template — emits index.ts with one export per entity, alphabetical.

import { GENERATED_HEADER, GENERATED_EDIT_NOTE } from "../constants.js";
import { type ExtStyle } from "../render-context.js";
import { barrelModuleSpecifier, type ResolvedTarget } from "../import-path.js";
import { CodeWriter } from "../writer/code-writer.js";
import { str } from "../writer/ts-writer.js";

export interface BarrelEntry {
  name: string;
  package: string | undefined;
}

export function renderBarrel(
  entries: BarrelEntry[],
  extStyle: ExtStyle,
  selfTarget: ResolvedTarget,
  entityModuleTarget: ResolvedTarget,
): string {
  const w = new CodeWriter();
  writeBarrel(w, entries, extStyle, selfTarget, entityModuleTarget);
  return w.toString();
}

/** Write {@link renderBarrel}'s module into `w`: the banner, then one `export *` per entry in name order. */
export function writeBarrel(
  w: CodeWriter,
  entries: readonly BarrelEntry[],
  extStyle: ExtStyle,
  selfTarget: ResolvedTarget,
  entityModuleTarget: ResolvedTarget,
): void {
  w.line(`// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`);
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    w.line("export * from ", str(barrelModuleSpecifier(selfTarget, entityModuleTarget, e.package, e.name, extStyle)), ";");
  }
}
