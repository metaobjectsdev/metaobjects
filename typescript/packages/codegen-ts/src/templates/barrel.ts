// Barrel template — emits index.ts with one export per entity, alphabetical.

import { GENERATED_HEADER } from "../constants.js";
import { withExt, type ExtStyle } from "../render-context.js";

export function renderBarrel(entityNames: string[], extStyle: ExtStyle = "none"): string {
  const sorted = [...entityNames].sort();
  const exports = sorted
    .map((n) => `export * from ${JSON.stringify(withExt(`./${n}`, extStyle))};`)
    .join("\n");
  return `// ${GENERATED_HEADER} — DO NOT EDIT.\n${exports}\n`;
}
