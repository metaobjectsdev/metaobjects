import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveCollection } from "@metaobjectsdev/sdk";
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

// Cheap substring probe, not a metamodel load: matches both canonical JSON's
// quoted `"requirement.functional"` key and sigil-free YAML's bare
// `requirement.functional:` authoring form.
const REQUIREMENT_NODE_MARKER = "requirement.";

/** Scans the project's resolved metadata collection (`resolveCollection` — the
 * single authority on where metadata lives, honouring declared `sources` rather
 * than assuming `metaobjects/`) for any file containing a `requirement.*` node
 * marker. Defensive throughout: no declared sources and no default directory, an
 * unresolvable source, or an unreadable file are all treated as "not found",
 * never thrown — this is a cheap heuristic, not a metamodel load. */
async function hasRequirementNodes(cwd: string): Promise<boolean> {
  try {
    const { files } = await resolveCollection(cwd);
    for (const file of files) {
      if (readFileSync(file, "utf8").includes(REQUIREMENT_NODE_MARKER)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function probe(cwd: string): Promise<ProjectProbe> {
  const deps = depNames(cwd);
  const names = existsSync(cwd) ? readdirSync(cwd) : [];
  const requirementNodes = await hasRequirementNodes(cwd);
  return {
    hasDep: (name) => deps.has(name),
    hasFileMatching: (re) => names.some((n) => re.test(n)),
    hasRequirementNodes: () => requirementNodes,
  };
}

/** Resolve the stack: explicit --server/--client overrides take precedence; otherwise detect.
 * Concern tokens (e.g. requirements) are always OBSERVED from project state, independent of
 * any --server/--client override — a concern is not a stack axis. */
export async function resolveStack(cwd: string, overrides: { servers: string[]; clients: string[] }): Promise<Stack> {
  const validServers = SERVER_LANGS as readonly string[];
  const validClients = CLIENT_FRAMEWORKS as readonly string[];
  const oServers = overrides.servers.filter((s): s is ServerLang => validServers.includes(s));
  const oClients = overrides.clients.filter((c): c is ClientFramework => validClients.includes(c));
  const p = await probe(cwd);
  const concerns = detectConcerns(p);
  if (oServers.length > 0 || oClients.length > 0) return makeStack(oServers, oClients, concerns);
  const detected = detectStack(p);
  return makeStack(detected.servers, detected.clients, concerns);
}
