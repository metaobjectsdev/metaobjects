// Barrel template — emits index.ts with one export per entity, alphabetical.

import { GENERATED_HEADER, GENERATED_EDIT_NOTE } from "../constants.js";
import { type ExtStyle } from "../render-context.js";
import { barrelModuleSpecifier, type ResolvedTarget } from "../import-path.js";

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
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const exports = sorted
    .map((e) => `export * from ${JSON.stringify(barrelModuleSpecifier(selfTarget, entityModuleTarget, e.package, e.name, extStyle))};`)
    .join("\n");
  return `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}\n${exports}\n`;
}
