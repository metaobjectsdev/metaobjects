import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveCollection } from "@metaobjectsdev/sdk";
import { declaredDependencyNames, readPackageManifest } from "./package-manifest.js";
import {
  detectStack, detectConcerns, makeStack,
  type ServerLang, type ClientFramework, type Stack, type ProjectProbe,
  SERVER_LANGS, CLIENT_FRAMEWORKS,
} from "@metaobjectsdev/sdk/agent-context";

function depNames(cwd: string): Set<string> {
  // An unreadable or absent manifest reads as no deps, which is what stack detection
  // wants: it probes, it does not require.
  return declaredDependencyNames(readPackageManifest(cwd) ?? {});
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

/**
 * Spellings accepted for a stack value that is not the canonical one.
 *
 * `node` is here because the CLI's OWN `--help` gives it as an example of `--server`, and it
 * is the more natural word for a Fastify backend run by the Node CLI. It used to be filtered
 * out silently — see `assertKnownStackValues` for what that silence cost.
 */
const SERVER_ALIASES: Readonly<Record<string, ServerLang>> = {
  node: "typescript",
  nodejs: "typescript",
  ts: "typescript",
  "c#": "csharp",
  dotnet: "csharp",
  py: "python",
};

const CLIENT_ALIASES: Readonly<Record<string, ClientFramework>> = {
  reactjs: "react",
  "react-query": "tanstack",
};

/** Canonicalize one value, or `undefined` when it names nothing we know. */
function canonical<T extends string>(
  raw: string,
  valid: readonly string[],
  aliases: Readonly<Record<string, T>>,
): T | undefined {
  const v = raw.trim().toLowerCase();
  if (valid.includes(v)) return v as T;
  return aliases[v];
}

/**
 * Refuse an unknown `--server` / `--client` value instead of dropping it.
 *
 * `--server node` — the CLI's own help example — used to exit 0 with no warning and record
 * `"servers": []`. Worse than the missing four reference fragments: a non-empty override
 * array suppresses BOTH the prior manifest's stack and detection, so the emitted context then
 * declared "Stack: no server, no client" and told the agent that this project has no
 * `metaobjects.config.ts` — about a project with a Fastify server, a React client, and the
 * very config file the same CLI had just read. One silently-dropped flag value made three
 * statements false in the artifact whose whole job is to orient an agent correctly.
 *
 * Either accept the value or say so; never neither.
 */
export function assertKnownStackValues(overrides: { servers: string[]; clients: string[] }): void {
  const bad: string[] = [];
  for (const s of overrides.servers) {
    if (canonical(s, SERVER_LANGS as readonly string[], SERVER_ALIASES) === undefined) {
      bad.push(`--server ${s} (known: ${SERVER_LANGS.join(", ")})`);
    }
  }
  for (const c of overrides.clients) {
    if (canonical(c, CLIENT_FRAMEWORKS as readonly string[], CLIENT_ALIASES) === undefined) {
      bad.push(`--client ${c} (known: ${CLIENT_FRAMEWORKS.join(", ")})`);
    }
  }
  if (bad.length > 0) {
    throw new Error(
      `unknown stack value(s): ${bad.join("; ")}. A value that names nothing is refused rather ` +
        "than dropped: an empty stack suppresses both the prior manifest and detection, and the " +
        "generated agent context then states the project has no server, no client and no " +
        "metaobjects.config.ts.",
    );
  }
}

/** Resolve the stack: explicit --server/--client overrides take precedence; otherwise detect.
 * Concern tokens (e.g. requirements) are always OBSERVED from project state, independent of
 * any --server/--client override — a concern is not a stack axis. */
export async function resolveStack(cwd: string, overrides: { servers: string[]; clients: string[] }): Promise<Stack> {
  const validServers = SERVER_LANGS as readonly string[];
  const validClients = CLIENT_FRAMEWORKS as readonly string[];
  const oServers = overrides.servers
    .map((s) => canonical<ServerLang>(s, validServers, SERVER_ALIASES))
    .filter((s): s is ServerLang => s !== undefined);
  const oClients = overrides.clients
    .map((c) => canonical<ClientFramework>(c, validClients, CLIENT_ALIASES))
    .filter((c): c is ClientFramework => c !== undefined);
  const p = await probe(cwd);
  const concerns = detectConcerns(p);
  if (oServers.length > 0 || oClients.length > 0) return makeStack(oServers, oClients, concerns);
  const detected = detectStack(p);
  return makeStack(detected.servers, detected.clients, concerns);
}
