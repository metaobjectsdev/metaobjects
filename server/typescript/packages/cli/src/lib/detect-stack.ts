import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  detectStack, makeStack,
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

function probe(cwd: string): ProjectProbe {
  const deps = depNames(cwd);
  const names = existsSync(cwd) ? readdirSync(cwd) : [];
  return {
    hasDep: (name) => deps.has(name),
    hasFileMatching: (re) => names.some((n) => re.test(n)),
  };
}

/** Resolve the stack: explicit --server/--client overrides take precedence; otherwise detect. */
export function resolveStack(cwd: string, overrides: { servers: string[]; clients: string[] }): Stack {
  const validServers = SERVER_LANGS as readonly string[];
  const validClients = CLIENT_FRAMEWORKS as readonly string[];
  const oServers = overrides.servers.filter((s): s is ServerLang => validServers.includes(s));
  const oClients = overrides.clients.filter((c): c is ClientFramework => validClients.includes(c));
  if (oServers.length > 0 || oClients.length > 0) return makeStack(oServers, oClients);
  const detected = detectStack(probe(cwd));
  return makeStack(detected.servers, detected.clients);
}
