import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// The agent-context subpath, not the root barrel: `@metaobjectsdev/sdk` exports TWO
// types named `Manifest` — this one (the scaffolded agent context) via `export *`,
// and FR-023's `metaobjects.pkg.json` explicitly. An explicit export shadows a
// star one, so the root barrel now hands out the dependency manifest under this
// name. `init.ts` already imports these from the subpath; this was the last site
// reading them from the root.
import { AGENT_CONTEXT_MANIFEST_PATH, agentContextCoverage, agentContextStaleness, hashAgentContextRoot, resolveAgentContextRoot, type Manifest } from "@metaobjectsdev/sdk/agent-context";
import { docsRefForVersion } from "@metaobjectsdev/metadata";
import { cliVersion } from "./version.js";
import { log } from "./log.js";

/** The installed content's hash, or nothing when the content tree cannot be found (version compare then). */
export function currentContentHash(): { currentContentHash?: string } {
  try {
    return { currentContentHash: hashAgentContextRoot(resolveAgentContextRoot(), docsRefForVersion(cliVersion())) };
  } catch {
    return {};
  }
}

/**
 * Advisory: if a scaffolded MetaObjects agent context predates this CLI version,
 * print a one-line nudge to re-scaffold. Never throws, never blocks — an absent or
 * corrupt manifest is silently ignored (this is a reminder, not a gate).
 *
 * Returns the line it printed, so a command with a structured result can carry it
 * there too; undefined when it said nothing.
 */
export function warnIfAgentContextStale(cwd: string): string | undefined {
  const read = readAgentContextManifest(cwd);
  if (read === "unreadable") return undefined; // corrupt — say nothing
  const manifest = read;
  const msg = agentContextStaleness({ manifest, currentVersion: cliVersion(), ...currentContentHash() });
  if (msg === null) return undefined;
  log.warn(msg);
  return msg;
}

/** The scaffolded manifest, `undefined` when there is none, `"unreadable"` when it is corrupt. */
function readAgentContextManifest(cwd: string): Manifest | undefined | "unreadable" {
  const p = join(cwd, AGENT_CONTEXT_MANIFEST_PATH);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Manifest;
  } catch {
    return "unreadable";
  }
}

/**
 * Advisory: the model declares requirements and the scaffolded agent context has no
 * requirements pages. Same contract as {@link warnIfAgentContextStale}: never throws, never
 * blocks, returns the line it printed.
 */
export function warnIfAgentContextMissesRequirements(cwd: string, declaresRequirements: boolean): string | undefined {
  const read = readAgentContextManifest(cwd);
  if (read === "unreadable") return undefined;
  const msg = agentContextCoverage({ manifest: read, declaresRequirements });
  if (msg === null) return undefined;
  log.warn(msg);
  return msg;
}
