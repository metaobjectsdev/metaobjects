/**
 * `.railway/railway.ts`: Railway's Infrastructure as Code file, in the `railway/iac` DSL of
 * the `railway` npm package (3.17.0; docs.railway.com/infrastructure-as-code/reference). The
 * `build` and `deploy` blocks use the SDK's `BuildConfig` and `DeployConfig` names, which the
 * reference page does not list.
 *
 * The file is a named partial, so it manages only the services it declares: the databases
 * and anything else Railway runs beside them are left alone. One branch per environment the
 * model deploys to; Railway passes the environment being planned in `ctx.environment`.
 */
import { BUILD_SUBTYPE_COMMAND, BUILD_SUBTYPE_DOCKERFILE } from "@metaobjectsdev/pack-delivery";
import { RESTART_POLICY, RAILWAY_IAC_MODULE, RAILWAY_SDK_VERSION } from "./constants.js";
import type { RailwayDeployment, RailwayProject } from "./model.js";

/** Code written as it is, not as a JSON value. */
class Code {
  constructor(readonly text: string) {}
}

type Value = string | number | boolean | Code | Commented | readonly Value[] | { readonly [key: string]: Value | undefined };

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function key(k: string): string {
  return IDENT.test(k) ? k : JSON.stringify(k);
}

/** An object whose entries each carry a trailing `// comment`. */
class Commented {
  constructor(
    readonly entries: Readonly<Record<string, Value>>,
    readonly comments: ReadonlyMap<string, string>,
  ) {}
}

/** A value as TypeScript source, one entry per line, at `indent`. */
function lit(v: Value, indent: string): string {
  let comments: ReadonlyMap<string, string> = new Map();
  if (v instanceof Commented) {
    comments = v.comments;
    v = v.entries;
  }
  if (v instanceof Code) return v.text;
  if (typeof v !== "object") return JSON.stringify(v);
  const inner = `${indent}  `;
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `[\n${v.map((x) => `${inner}${lit(x as Value, inner)},`).join("\n")}\n${indent}]`;
  }
  const entries = Object.entries(v as Record<string, Value | undefined>).filter((e): e is [string, Value] => e[1] !== undefined);
  if (entries.length === 0) return "{}";
  const lines = entries.map(([k, x]) => {
    const note = comments.get(k);
    return `${inner}${key(k)}: ${lit(x, inner)},${note === undefined ? "" : ` // ${note}`}`;
  });
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function watchPatterns(d: RailwayDeployment): string[] | undefined {
  const b = d.build;
  if (b === undefined || (b.watchInclude.length === 0 && b.watchExclude.length === 0)) return undefined;
  const include = b.watchInclude.length > 0 ? b.watchInclude : ["**"];
  return [...include, ...b.watchExclude.map((g) => `!${g}`)];
}

/** The block when any of its entries is set, else undefined (the key is then left out). */
function nonEmpty(block: Record<string, Value | undefined>): Record<string, Value | undefined> | undefined {
  return Object.values(block).some((x) => x !== undefined) ? block : undefined;
}

function buildBlock(d: RailwayDeployment): Record<string, Value | undefined> | undefined {
  const b = d.build;
  const out: Record<string, Value | undefined> = {};
  if (b?.kind === BUILD_SUBTYPE_DOCKERFILE && b.path !== undefined) {
    out["builder"] = "DOCKERFILE";
    out["dockerfilePath"] = b.path;
  }
  if (b?.kind === BUILD_SUBTYPE_COMMAND && b.command !== undefined) out["buildCommand"] = b.command;
  out["watchPatterns"] = watchPatterns(d);
  return nonEmpty(out);
}

function deployBlock(d: RailwayDeployment): Record<string, Value | undefined> | undefined {
  const p = d.processes[0];
  return nonEmpty({
    startCommand: p?.command,
    healthcheckPath: p?.healthPath,
    healthcheckTimeout: p?.healthTimeoutSeconds,
    restartPolicyType: p?.restart === undefined ? undefined : RESTART_POLICY[p.restart],
    drainingSeconds: p?.drainSeconds,
    cronSchedule: d.schedule,
  });
}

function sourceCall(d: RailwayDeployment, imports: Set<string>): Code | undefined {
  if (d.image !== undefined) {
    imports.add("image");
    return new Code(`image(${JSON.stringify(d.image)})`);
  }
  if (d.repo === undefined) return undefined;
  imports.add("github");
  const opts: Record<string, Value | undefined> = { branch: d.branch, checkSuites: d.checkSuites };
  const set = Object.entries(opts).filter(([, v]) => v !== undefined);
  const tail = set.length === 0 ? "" : `, { ${set.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} }`;
  return new Code(`github(${JSON.stringify(d.repo)}${tail})`);
}

function serviceCall(d: RailwayDeployment, manageVariables: boolean, imports: Set<string>, indent: string): string {
  const port = d.processes.find((p) => p.port !== undefined)?.port;
  const domains = d.domains.map((domain) => (port === undefined ? domain : { domain, port }));
  const replicas: Value | undefined =
    d.region !== undefined ? { [d.region]: d.replicas ?? 1 } : d.replicas;
  let env: Commented | undefined;
  if (manageVariables) {
    const entries: Record<string, Value> = {};
    for (const v of d.variables) {
      if (v.kind === "preserve") imports.add("preserve");
      entries[v.name] = v.kind === "preserve" ? new Code("preserve()") : v.value ?? "";
    }
    env = new Commented(entries, new Map(d.variables.map((v) => [v.name, v.from])));
  }
  const config: Record<string, Value | undefined> = {
    source: sourceCall(d, imports),
    build: buildBlock(d),
    deploy: deployBlock(d),
    domains: domains.length === 0 ? undefined : domains,
    replicas,
    env,
  };
  return `service(${JSON.stringify(d.service)}, ${lit(config, indent)})`;
}

function projectCall(project: RailwayProject, ds: readonly RailwayDeployment[], imports: Set<string>, indent: string): string {
  const inner = `${indent}  `;
  // Each service names the model nodes its facts come from.
  const services = ds
    .map((d) => `${inner}  // ${d.appKey}, deployed by deployment.railway ${d.key}\n${inner}  ${serviceCall(d, project.manageVariables, imports, `${inner}  `)},`)
    .join("\n");
  // Spread from a constant: the railway SDK's types do not declare `variables`, which only an
  // object literal's excess-property check would refuse, so the file type-checks.
  const variables = project.manageVariables ? "" : `${inner}...unmanagedVariables,\n`;
  return `project(${JSON.stringify(project.name)}, {\n${variables}${inner}resources: [\n${services}\n${inner}],\n${indent}})`;
}

export function renderRailwayTs(project: RailwayProject, header: string): string {
  const imports = new Set(["defineRailway", "project", "service"]);
  const branches = project.environments.map((env) => {
    const ds = project.deployments.filter((d) => d.environment === env);
    return `  if (ctx.environment === ${JSON.stringify(env)}) {\n    return ${projectCall(project, ds, imports, "    ")};\n  }`;
  });
  const declared = project.environments.join(", ");
  const variablesNote = project.manageVariables
    ? [
        "// Variables are managed: the file declares every variable of its services, and an apply",
        "// deletes one it does not declare. A secret is preserve(): deploy/sync-secrets.sh copies its",
        "// value from the vault.",
      ]
    : [
        "// Variables are unmanaged (`variables: { managed: false }`): an apply changes no variable.",
        "// Secrets reach Railway through deploy/sync-secrets.sh, which copies them from the vault.",
      ];
  const lines = [
    header,
    `// Railway Infrastructure as Code for project ${project.name}, from the model (railway pack).`,
    `// The \`${RAILWAY_IAC_MODULE}\` DSL of the \`railway\` npm package ${RAILWAY_SDK_VERSION}.`,
    "//",
    "// Railway does not read this file during a deploy. It takes effect when `railway config apply`",
    "// runs against an environment; `railway config plan` previews it. Both need the SDK beside it:",
    `// \`npm install --no-save --prefix .railway railway@${RAILWAY_SDK_VERSION}\`. deploy/deploy.sh does both.`,
    "//",
    `// A named partial: it manages only the services below. Databases and anything else it does`,
    "// not declare are left as they are, and the facts it cannot hold are in deploy/unexpressed.md.",
    ...variablesNote,
    `import { ${[...imports].sort().join(", ")} } from ${JSON.stringify(RAILWAY_IAC_MODULE)};`,
    "",
    `export const partial = ${JSON.stringify(project.partial)};`,
    "",
    ...(project.manageVariables
      ? []
      : [
          `/** Read by the Railway CLI (its variable policy); the railway ${RAILWAY_SDK_VERSION} SDK's types do not declare it yet. */`,
          "const unmanagedVariables = { variables: { managed: false } };",
          "",
        ]),
    "export default defineRailway((ctx) => {",
    ...branches,
    `  throw new Error(\`.railway/railway.ts: the model deploys nothing to environment "\${ctx.environment}" (it deploys to: ${declared})\`);`,
    "});",
    "",
  ];
  return lines.join("\n");
}
