// rc.21 part B (I2): an extender keeps its super's identity anchor, so a view whose own fields read
// a TPH subtype's columns now returns every base row. The loader records that on its warning
// channel, which `loadMemory` does not return, so every command that loads a model to emit or check
// views — gen, migrate, verify — says it here, the same way.

import { validateExtenderSubtypeScope, type MetaData } from "@metaobjectsdev/metadata";

/** Print each widened-extender finding through `warn` and return the findings. */
export function warnWidenedExtenders(root: MetaData, warn: (line: string) => void): string[] {
  const findings = validateExtenderSubtypeScope(root);
  for (const w of findings) warn(`warning: ${w}`);
  return findings;
}
