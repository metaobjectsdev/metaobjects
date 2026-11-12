import { existsSync, readdirSync } from "node:fs";
import { declaredDependencyNames, readPackageManifest } from "./package-manifest.js";
import {
  detectStack, makeStack,
  type ServerLang, type ClientFramework, type Stack, type ProjectProbe,
  SERVER_LANGS, CLIENT_FRAMEWORKS,
} from "@metaobjectsdev/sdk/agent-context";

function depNames(cwd: string): Set<string> {
  // An unreadable or absent manifest reads as no deps, which is what stack detection
  // wants: it probes, it does not require.
  return declaredDependencyNames(readPackageManifest(cwd) ?? {});
}

function probe(cwd: string): ProjectProbe {
  const deps = depNames(cwd);
  const names = existsSync(cwd) ? readdirSync(cwd) : [];
  return {
    hasDep: (name) => deps.has(name),
    hasFileMatching: (re) => names.some((n) => re.test(n)),
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

/** Resolve the stack: explicit --server/--client overrides take precedence; otherwise detect. */
export async function resolveStack(cwd: string, overrides: { servers: string[]; clients: string[] }): Promise<Stack> {
  const validServers = SERVER_LANGS as readonly string[];
  const validClients = CLIENT_FRAMEWORKS as readonly string[];
  const oServers = overrides.servers
    .map((s) => canonical<ServerLang>(s, validServers, SERVER_ALIASES))
    .filter((s): s is ServerLang => s !== undefined);
  const oClients = overrides.clients
    .map((c) => canonical<ClientFramework>(c, validClients, CLIENT_ALIASES))
    .filter((c): c is ClientFramework => c !== undefined);
  if (oServers.length > 0 || oClients.length > 0) return makeStack(oServers, oClients);
  const detected = detectStack(probe(cwd));
  return makeStack(detected.servers, detected.clients);
}
