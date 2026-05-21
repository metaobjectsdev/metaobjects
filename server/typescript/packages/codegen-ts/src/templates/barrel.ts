// Barrel template — emits index.ts with one export per entity, alphabetical.

import { GENERATED_HEADER } from "../constants.js";
import { type ExtStyle } from "../render-context.js";
import { barrelEntrySpecifier, type OutputLayout } from "../import-path.js";

export interface BarrelEntry {
  name: string;
  package: string | undefined;
}

export function renderBarrel(
  entries: BarrelEntry[],
  extStyle: ExtStyle = "none",
  layout: OutputLayout = "flat",
): string {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const exports = sorted
    .map((e) => `export * from ${JSON.stringify(barrelEntrySpecifier(layout, e.package, e.name, extStyle))};`)
    .join("\n");
  return `// ${GENERATED_HEADER} — DO NOT EDIT.\n${exports}\n`;
}
