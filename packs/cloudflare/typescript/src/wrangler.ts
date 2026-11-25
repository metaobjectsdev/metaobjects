/**
 * `wrangler.jsonc`: the Worker's Wrangler configuration, written from the model.
 *
 * The top-level environment's deployment is written at the top level (`wrangler deploy`), and
 * every other environment is an `env.<name>` block (`wrangler deploy --env <name>`). Wrangler
 * inherits some top-level keys into an env block and not others (`vars`, `secrets` and every
 * binding are never inherited), and a forgotten key is a silent difference between
 * environments. So each env block is written in full: every key the top level has, with that
 * environment's own value, an empty one included. What one environment's block says never
 * depends on what Wrangler would fill in.
 *
 * Every fact carries a `//` comment naming the model node it came from. Paths in the model are
 * from the repository root; Wrangler reads them from the file's own directory, so they are
 * rewritten relative to where the file is written.
 */
import { posix } from "node:path";
import { WRANGLER_SCHEMA_REF } from "./constants.js";
import { workerName, type CloudflareApp, type CloudflareBinding, type WorkerDeployment } from "./model.js";

// ── a small JSONC writer: objects whose entries may carry a comment line ─────

interface Entry {
  readonly key: string;
  readonly value: Json;
  readonly comment?: string;
}

class Obj {
  constructor(readonly entries: readonly Entry[]) {}
}

type Json = string | number | boolean | null | readonly Json[] | Obj;

function entry(key: string, value: Json, comment?: string): Entry {
  return comment === undefined ? { key, value } : { key, value, comment };
}

function obj(...entries: (Entry | undefined)[]): Obj {
  return new Obj(entries.filter((e): e is Entry => e !== undefined));
}

function isScalar(v: Json): v is string | number | boolean | null {
  return v === null || typeof v !== "object";
}

function print(v: Json, indent: string): string {
  if (isScalar(v)) return JSON.stringify(v);
  const inner = `${indent}  `;
  if (v instanceof Obj) {
    if (v.entries.length === 0) return "{}";
    const lines: string[] = [];
    v.entries.forEach((e, i) => {
      if (e.comment !== undefined) for (const c of e.comment.split("\n")) lines.push(`${inner}// ${c}`);
      lines.push(`${inner}${JSON.stringify(e.key)}: ${print(e.value, inner)}${i < v.entries.length - 1 ? "," : ""}`);
    });
    return `{\n${lines.join("\n")}\n${indent}}`;
  }
  const arr = v as readonly Json[];
  if (arr.length === 0) return "[]";
  if (arr.every(isScalar)) return `[${arr.map((x) => JSON.stringify(x)).join(", ")}]`;
  return `[\n${arr.map((x) => `${inner}${print(x, inner)}`).join(",\n")}\n${indent}]`;
}

/** The text with its full-line `//` comments removed, as JSON. The generated file has no other comments. */
export function parseGeneratedJsonc(text: string): unknown {
  return JSON.parse(
    text
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n"),
  );
}

// ── the configuration ────────────────────────────────────────────────────────

/** A repository-root path as Wrangler reads it from the file at `configPath` (`src/index.ts`). */
function fromConfig(configPath: string, path: string): string {
  const rel = posix.relative(posix.dirname(posix.normalize(configPath)), posix.normalize(path));
  return rel === "" ? "." : rel;
}

/** A directory as Wrangler's own examples write one: `./dist/client`. */
function dirFromConfig(configPath: string, path: string): string {
  const rel = fromConfig(configPath, path);
  return rel === "." || rel.startsWith("../") ? rel : `./${rel}`;
}

function bindingsOf<K extends CloudflareBinding["kind"]>(d: WorkerDeployment, kind: K): Extract<CloudflareBinding, { kind: K }>[] {
  return d.bindings.filter((b): b is Extract<CloudflareBinding, { kind: K }> => b.kind === kind);
}

/** One environment's keys, each written whether or not it is empty (see the module comment). */
function environmentEntries(d: WorkerDeployment, name: string, configPath: string): Entry[] {
  const out: Entry[] = [];
  const push = (key: string, value: Json, comment?: string): void => {
    out.push(entry(key, value, comment));
  };
  push("name", name, `deployment.worker ${d.key}: environment ${d.environment}`);
  if (d.main !== undefined) push("main", fromConfig(configPath, d.main), "@main");
  push("compatibility_date", d.compatibilityDate, "@compatibilityDate");
  push("compatibility_flags", d.compatibilityFlags, "@compatibilityFlags");
  if (d.workersDev !== undefined) push("workers_dev", d.workersDev, "@workersDev");
  push(
    "routes",
    d.domains.map((pattern) => obj(entry("pattern", pattern), entry("custom_domain", true))),
    "@domains: each a custom domain, its DNS record and certificate made by Cloudflare",
  );
  if (d.assets !== undefined) {
    const a = d.assets;
    push(
      "assets",
      obj(
        entry("directory", dirFromConfig(configPath, a.directory)),
        a.binding === undefined ? undefined : entry("binding", a.binding, "@assetsBinding"),
        a.notFound === undefined ? undefined : entry("not_found_handling", a.notFound, "@notFound"),
        a.workerFirst === undefined ? undefined : entry("run_worker_first", a.workerFirst === true ? true : [...a.workerFirst], a.workerFirst === true ? "@workerFirst" : "@workerFirstPaths"),
      ),
      `the app's ${d.build?.from ?? "build.static"} @directory`,
    );
  }
  push("triggers", obj(entry("crons", d.crons.map((c) => c.schedule))), d.crons.length > 0 ? d.crons.map((c) => c.from).join("\n") : "@jobs: none, so no cron triggers");
  push("vars", obj(...d.vars.map((v) => entry(v.name, v.value, v.from))), "the app's non-secret runtime settings (@settings)");
  push(
    "secrets",
    obj(entry("required", [...d.secrets])),
    "the app's @secret runtime settings: values from the vault, copied by deploy/cloudflare/sync-secrets.sh",
  );
  push(
    "d1_databases",
    bindingsOf(d, "d1").map((b) =>
      obj(
        entry("binding", b.binding),
        entry("database_name", b.databaseName),
        b.databaseId === undefined ? undefined : entry("database_id", b.databaseId),
        b.migrationsDir === undefined ? undefined : entry("migrations_dir", fromConfig(configPath, b.migrationsDir)),
      ),
    ),
    comment(bindingsOf(d, "d1"), "d1"),
  );
  push("kv_namespaces", bindingsOf(d, "kv").map((b) => obj(entry("binding", b.binding), entry("id", b.namespaceId))), comment(bindingsOf(d, "kv"), "kv"));
  push("r2_buckets", bindingsOf(d, "r2").map((b) => obj(entry("binding", b.binding), entry("bucket_name", b.bucketName))), comment(bindingsOf(d, "r2"), "r2"));
  push("queues", obj(entry("producers", bindingsOf(d, "queue").map((b) => obj(entry("binding", b.binding), entry("queue", b.queue))))), comment(bindingsOf(d, "queue"), "queue"));
  push(
    "ratelimits",
    bindingsOf(d, "ratelimit").map((b) => obj(entry("name", b.binding), entry("namespace_id", b.namespaceId), entry("simple", obj(entry("limit", b.limit), entry("period", b.period))))),
    comment(bindingsOf(d, "ratelimit"), "ratelimit"),
  );
  if (d.extra !== undefined) {
    const keys = Object.keys(d.extra);
    keys.forEach((k, i) => push(k, fromPlain(d.extra![k]), i === 0 ? "@extra: written as the model gives it" : undefined));
  }
  return out;
}

function comment(bs: readonly CloudflareBinding[], kind: string): string {
  return bs.length === 0 ? `no cloudflare.${kind} binding` : bs.map((b) => b.from).join("\n");
}

/** An `@extra` value (plain JSON) as a writer value. */
function fromPlain(v: unknown): Json {
  if (v === null) return null;
  if (Array.isArray(v)) return v.map(fromPlain);
  if (typeof v === "object") return new Obj(Object.entries(v as Record<string, unknown>).map(([k, x]) => entry(k, fromPlain(x))));
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}

/** `wrangler.jsonc` for one Worker app, `configPath` being where it is written; `header` is a `//` line. */
export function renderWrangler(app: CloudflareApp, header: string, configPath: string): string {
  const workers = app.deployments as readonly WorkerDeployment[];
  const top = workers[0]!;
  const rest = workers.slice(1);
  const depth = posix.normalize(configPath).split("/").length - 1;
  const schema = `${depth === 0 ? "./" : "../".repeat(depth)}${WRANGLER_SCHEMA_REF}`;
  const root = obj(
    entry("$schema", schema),
    ...environmentEntries(top, top.script, configPath),
    rest.length === 0
      ? undefined
      : entry(
          "env",
          obj(...rest.map((d) => entry(d.environment, obj(...environmentEntries(d, workerName(d, top), configPath)), `\`wrangler deploy --env ${d.environment}\``))),
          "Every environment is written in full: Wrangler does not inherit vars, secrets or bindings into an env block.",
        ),
  );
  const lines = [
    header,
    `// Wrangler configuration for ${app.appKey}, from the model. \`wrangler deploy\` deploys ${app.topLevel};`,
    `// ${rest.length === 0 ? "it is the only environment." : `\`wrangler deploy --env <name>\` deploys ${rest.map((d) => d.environment).join(", ")}.`} Deploy with deploy/cloudflare/deploy.sh <environment>.`,
    print(root, ""),
  ];
  return `${lines.join("\n")}\n`;
}
