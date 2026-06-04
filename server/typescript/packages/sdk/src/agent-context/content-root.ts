import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A directory is a valid content root iff it holds the authoring skill body. */
function isContentRoot(dir: string): boolean {
  return existsSync(join(dir, "skills", "metaobjects-authoring", "SKILL.md"));
}

/**
 * Resolve the `agent-context/` content tree the assembler reads.
 * - If `override` is given, it must be a valid content root (else throw).
 * - Otherwise: check a bundled copy beside this module (`<pkg>/agent-context`,
 *   the published path), then walk up looking for a monorepo `agent-context/` (dev).
 */
export function resolveAgentContextRoot(override?: string): string {
  if (override !== undefined) {
    if (isContentRoot(override)) return override;
    throw new Error(`agent-context content not found at override: ${override}`);
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const bundled = join(dir, "agent-context");
    if (isContentRoot(bundled)) return bundled;
    const mono = join(dir, "agent-context");
    if (isContentRoot(mono)) return mono;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "agent-context content not found — looked for a bundled `agent-context/` beside the package " +
      "and a monorepo `agent-context/` walking up from the sdk module.",
  );
}
