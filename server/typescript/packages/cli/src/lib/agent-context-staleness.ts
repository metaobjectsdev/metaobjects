import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_CONTEXT_MANIFEST_PATH, agentContextStaleness, type Manifest } from "@metaobjectsdev/sdk";
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
