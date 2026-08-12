import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import {
  detectStack, detectConcerns, makeStack,
  type ServerLang, type ClientFramework, type Stack, type ProjectProbe,
  SERVER_LANGS, CLIENT_FRAMEWORKS,
} from "@metaobjectsdev/sdk/agent-context";

function depNames(cwd: string): Set<string> {
  const out = new Set<string>();
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, Record<string, string>>;
      for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
        for (const name of Object.keys(pkg[key] ?? {})) out.add(name);
      }
    } catch { /* unreadable manifest — treat as no deps */ }
  }
  return out;
}

const METADATA_DIR = "metaobjects";
const METADATA_FILE_PATTERN = /\.(json|ya?ml)$/i;
// Cheap substring probe, not a metamodel load: matches both canonical JSON's
// quoted `"requirement.functional"` key and sigil-free YAML's bare
// `requirement.functional:` authoring form.
const REQUIREMENT_NODE_MARKER = "requirement.";

/** Recursively scans `metaobjects/` for any `.json`/`.yaml`/`.yml` file containing a
 * `requirement.*` node marker. Defensive throughout: a missing/unreadable directory
 * or file is treated as "not found", never thrown — this is a cheap heuristic, not
 * a metamodel load. */
function hasRequirementNodes(cwd: string): boolean {
  const root = join(cwd, METADATA_DIR);
  if (!existsSync(root)) return false;
  const pending: string[] = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip it, keep scanning siblings
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (METADATA_FILE_PATTERN.test(entry.name)) {
        try {
          if (readFileSync(full, "utf8").includes(REQUIREMENT_NODE_MARKER)) return true;
        } catch { /* unreadable file — treat as no match */ }
      }
    }
  }
  return false;
}

function probe(cwd: string): ProjectProbe {
  const deps = depNames(cwd);
  const names = existsSync(cwd) ? readdirSync(cwd) : [];
  return {
    hasDep: (name) => deps.has(name),
    hasFileMatching: (re) => names.some((n) => re.test(n)),
    hasRequirementNodes: () => hasRequirementNodes(cwd),
  };
}

/** Resolve the stack: explicit --server/--client overrides take precedence; otherwise detect.
 * Concern tokens (e.g. requirements) are always OBSERVED from project state, independent of
 * any --server/--client override — a concern is not a stack axis. */
export function resolveStack(cwd: string, overrides: { servers: string[]; clients: string[] }): Stack {
  const validServers = SERVER_LANGS as readonly string[];
  const validClients = CLIENT_FRAMEWORKS as readonly string[];
  const oServers = overrides.servers.filter((s): s is ServerLang => validServers.includes(s));
  const oClients = overrides.clients.filter((c): c is ClientFramework => validClients.includes(c));
  const p = probe(cwd);
  const concerns = detectConcerns(p);
  if (oServers.length > 0 || oClients.length > 0) return makeStack(oServers, oClients, concerns);
  const detected = detectStack(p);
  return makeStack(detected.servers, detected.clients, concerns);
}
