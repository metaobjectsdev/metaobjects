import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// The agent-context subpath, not the root barrel: `@metaobjectsdev/sdk` exports TWO
// types named `Manifest` — this one (the scaffolded agent context) via `export *`,
// and FR-023's `metaobjects.pkg.json` explicitly. An explicit export shadows a
// star one, so the root barrel now hands out the dependency manifest under this
// name. `init.ts` already imports these from the subpath; this was the last site
// reading them from the root.
import { AGENT_CONTEXT_MANIFEST_PATH, agentContextStaleness, type Manifest } from "@metaobjectsdev/sdk/agent-context";
import { cliVersion } from "./version.js";
import { log } from "./log.js";

/**
 * Advisory: if a scaffolded MetaObjects agent context predates this CLI version,
 * print a one-line nudge to re-scaffold. Never throws, never blocks — an absent or
 * corrupt manifest is silently ignored (this is a reminder, not a gate).
 */
export function warnIfAgentContextStale(cwd: string): void {
  const p = join(cwd, AGENT_CONTEXT_MANIFEST_PATH);
  let manifest: Manifest | undefined;
  if (existsSync(p)) {
    try {
      manifest = JSON.parse(readFileSync(p, "utf8")) as Manifest;
    } catch {
      return; // unreadable/corrupt — say nothing
    }
  }
  const msg = agentContextStaleness({ manifest, currentVersion: cliVersion() });
  if (msg !== null) log.warn(msg);
}
