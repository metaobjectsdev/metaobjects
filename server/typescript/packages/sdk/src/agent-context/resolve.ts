import {
  SERVER_LANGS, CLIENT_FRAMEWORKS, MIGRATION_TOKEN,
  type ServerLang, type ClientFramework, type Stack,
} from "./types.js";

export interface ProjectProbe {
  hasDep(name: string): boolean;
  hasFileMatching(pattern: RegExp): boolean;
}

export function makeStack(servers: ServerLang[], clients: ClientFramework[]): Stack {
  const s = SERVER_LANGS.filter((x) => servers.includes(x));
  const c = CLIENT_FRAMEWORKS.filter((x) => clients.includes(x));
  return { servers: s, clients: c, tokens: new Set<string>([...s, ...c, MIGRATION_TOKEN]) };
}

/** Best-effort detection from a project probe. Always overridable; a wrong guess
 * writes an extra fragment, never a wrong one (callers confirm before scaffolding). */
export function detectStack(probe: ProjectProbe): { servers: ServerLang[]; clients: ClientFramework[] } {
  const servers: ServerLang[] = [];
  if (probe.hasDep("@metaobjectsdev/cli") || probe.hasDep("@metaobjectsdev/codegen-ts")) servers.push("typescript");
  if (probe.hasFileMatching(/(^|\/)build\.gradle(\.kts)?$/)) servers.push("kotlin");
  if (probe.hasFileMatching(/(^|\/)pom\.xml$/)) servers.push("java");
  if (probe.hasFileMatching(/\.csproj$/)) servers.push("csharp");
  if (probe.hasFileMatching(/(^|\/)(pyproject\.toml|setup\.py)$/)) servers.push("python");

  const clients: ClientFramework[] = [];
  if (probe.hasDep("@metaobjectsdev/react")) clients.push("react");
  if (probe.hasDep("@metaobjectsdev/tanstack")) clients.push("tanstack");
  if (probe.hasDep("@metaobjectsdev/angular")) clients.push("angular");

  return { servers, clients };
}
