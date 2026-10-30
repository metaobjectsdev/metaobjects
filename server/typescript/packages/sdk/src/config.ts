import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceSpec } from "./sources.js";
import { DependencySpecSchema, type DependencySpec } from "./dependencies.js";
import {
  COLUMN_NAMING_STRATEGIES,
  DEFAULT_PHYSICAL_NAMING,
  TABLE_NAMING_RULES,
  DEFAULT_WIRE_FORMAT,
  WIRE_DECIMALS,
  WIRE_NULL_MEMBERS,
  WIRE_KEY_DECIMALS,
  WIRE_KEY_NULL_MEMBERS,
  type WireDecimals,
  type WireFormat,
  type WireNullMembers,
  type PhysicalNaming,
  type ColumnNamingStrategy,
  type TableNamingRule,
} from "@metaobjectsdev/metadata";

const DialectEnum = z.enum(["sqlite", "postgres", "d1"]);

const OnAmbiguousEnum = z.enum(["abort", "rename", "drop-add"]);

/**
 * Kept in lockstep with the CLI's authoritative `ALLOW_TOKENS`
 * (`cli/src/lib/args.ts`) by hand — `sdk` has no dependency on `cli` (the
 * dependency runs the other way: `cli` depends on `sdk`), so this list
 * cannot import that one. `cli`'s `allow-tokens-pinned.test.ts` is the
 * drift guard: it imports BOTH `ALLOW_TOKENS` and this enum's `.options`
 * and asserts they're the same set, so an out-of-sync edit here fails that
 * test rather than silently rejecting a token the CLI itself accepts (as
 * happened before `drop-check`/`drop-view`/`drop-view-cascade`/
 * `adopt-view`/`drop-identity-default` were added to `cli` without a
 * matching update here).
 */
export const AllowTokenEnum = z.enum([
  "drop-column",
  "drop-table",
  "type-change",
  "drop-index",
  "drop-fk",
  "drop-check",
  "drop-view",
  "drop-view-cascade",
  "adopt-view",
  "nullable-to-not-null",
  "drop-identity-default",
  "drop-unmanaged",
  "drop-comment",
]);

// .strict(), like every other object in this schema: `.partial()` alone leaves
// zod's default STRIP policy in place, so a misspelled key is silently deleted
// and the block reads as if the author never wrote it.
const D1Block = z.object({
  binding: z.string(),
  remote: z.boolean(),
  autoApply: z.boolean(),
  wranglerConfigPath: z.string(),
}).partial().strict();

/** #192 — migration output-format adapters; orthogonal to dialect. */
const MigrateFormatEnum = z.enum(["default", "flyway"]);

const MigrateBlock = z.object({
  outDir: z.string(),
  databaseUrl: z.string(),
  /** Postgres: a scratch database `meta verify --db` and `meta migrate` apply the expected schema to. */
  shadowDatabaseUrl: z.string(),
  dialect: DialectEnum,
  format: MigrateFormatEnum,
  onAmbiguous: OnAmbiguousEnum,
  allow: z.array(AllowTokenEnum),
  d1: D1Block,
  /** Restricts a `meta migrate` run to a subset of the loaded metadata, by the
   *  same package-glob pattern grammar as top-level `scope` (see `scope.ts`).
   *  Include-only — there's no `migrate.scope.exclude`, since a migration run
   *  is scoped to what it's touching, not filtered down from "everything". */
  scope: z.array(z.string().min(1)),
// .strict() for the same reason as the top level and the source arms below, and
// with sharper teeth here: `{ migrate: { scopee: [...], dialect: "postgres" } }`
// used to parse to `{ dialect: "postgres" }`, so a typo'd `scope` key meant
// "unscoped" — silently governing every table in the database, which is the
// hazard `migrate.scope` exists to remove.
}).partial().strict();

/**
 * Mirrors the hand-written `SourceSpec` union in `./sources.ts` — a
 * declared source kind, one of `path` (resolves today), `resource`, or
 * `package` (both reserved, throw `ERR_SOURCE_KIND_UNSUPPORTED` until a
 * later phase). `.strict()` on every arm: this project is fail-closed on
 * undeclared keys everywhere else (ADR-0023 makes an unregistered metadata
 * attribute a hard error for the same reason) — a config schema that
 * silently strips an unknown key would let `{ path: "model", pathh: "typo"
 * }` parse clean and resolve one source instead of erroring on the typo.
 * The pre-phase-1 `{ kind: "path", path: "..." }` shape (the dead 2-arm
 * discriminated union this replaces) never shipped to an adopter — `meta
 * init` has only ever scaffolded `"sources": []`, and nothing under `src/`
 * ever read the old shape — so there is no live config to be lenient for;
 * it only ever existed in this package's own tests, updated alongside this
 * schema.
 */
const SourceSpecSchema = z.union([
  z.object({ path: z.string().min(1) }).strict(),
  z.object({ resource: z.string().min(1) }).strict(),
  z.object({ package: z.string().min(1) }).strict(),
]);

// Compile-time parity, BOTH directions: if SourceSpecSchema and the
// hand-written SourceSpec (./sources.ts) ever drift, one of these two
// assignments stops compiling. Each direction alone catches only HALF the
// drift — `z.infer<...>` assignable to `SourceSpec` catches an arm added to
// the schema but missing from SourceSpec, while `SourceSpec` assignable to
// `z.infer<...>` catches the opposite: an arm added to the hand-written
// SourceSpec that the schema never gained. A single one-directional
// assignment (the prior form of this guard) let a SourceSpec-only addition
// compile clean — proven by deliberately breaking each direction in
// isolation; see the quality-pass report for both failing `tsc` outputs. A
// conditional type (`X extends Y ? true : never`) would silently resolve to
// `never` instead of erroring — this direct-assignment form fails for real.
const _sourceSpecParityInferToSpec: SourceSpec = {} as z.infer<typeof SourceSpecSchema>;
const _sourceSpecParitySpecToInfer: z.infer<typeof SourceSpecSchema> = {} as SourceSpec;
void _sourceSpecParityInferToSpec;
void _sourceSpecParitySpecToInfer;

// Compile-time parity, BOTH directions, for `DependencySpecSchema` /
// `DependencySpec` — same rationale as the `SourceSpec` pair above: a
// one-directional assignment would let either side add an arm the other
// never gained and still compile clean.
const _dependencySpecParityInferToSpec: DependencySpec = {} as z.infer<typeof DependencySpecSchema>;
const _dependencySpecParitySpecToInfer: z.infer<typeof DependencySpecSchema> = {} as DependencySpec;
void _dependencySpecParityInferToSpec;
void _dependencySpecParitySpecToInfer;

/** Mirrors the hand-written `Scope` interface in `./scope.ts`. An absent or
 *  empty `include` means "everything" — see `matchesScope`. */
const ScopeSchema = z
  .object({
    include: z.array(z.string().min(1)).optional(),
    exclude: z.array(z.string().min(1)).optional(),
  })
  .strict();

// .strict() at the TOP level too, not just the source-spec arms and the
// scope block: without it, a misspelled top-level key (e.g. "scopes" for
// "scope") is silently stripped by zod and the collection resolves as
// "everything in scope" — the exact silent fail-open .strict() on the
// nested arms exists to prevent, one level up.
export const ConfigSchema = z.object({
  schema_version: z.literal(1),
  pending_in_git: z.boolean().default(true),
  confidence_thresholds: z
    .object({
      pending_promote: z.number().min(0).max(1).default(0.8),
      drift_warn: z.number().min(0).max(1).default(0.7),
    })
    .prefault({}),
  sources: z.array(SourceSpecSchema).default([]),
  /** Declared metadata dependencies (FR-023) — read from this file at every
   *  rung of the source ladder, by every port, not just TypeScript (DESIGN
   *  §2.3). Names must be unique across the array. */
  dependencies: z
    .array(DependencySpecSchema)
    .default([])
    .refine((a) => new Set(a.map((d) => d.name)).size === a.length, {
      message: "dependencies: names must be unique",
    }),
  /**
   * MetaObjects-shipped libraries this project opts into (FR-043).
   *
   * Path-like tokens: `"iam"` is the core layer, `"iam/db"` adds its persistence layer
   * and IMPLIES the core. A library's CORE layer declares no `source.rdb`, so naming one
   * adds zero tables and zero generated code — the design is present and resolvable, and
   * nothing else happens until a layer is named.
   *
   * Declared HERE, beside `dependencies`, and no longer in `metaobjects.config.ts`
   * (FR-043 Amendment 1, §12 Q4). Two reasons: which designs a project adopts is a fact
   * about the PROJECT, not about how one port generates code from it, and this file is
   * the port-neutral one every port already reads. Moved outright with no dual-read,
   * because a sweep of the estate found zero configs using the old key — there is no
   * installed base to be compatible with.
   */
  libraries: z.array(z.string()).default([]),
  /** Output filter applied across every command — see `./scope.ts`. Absent
   *  means "everything" (no filtering), matching `Scope`'s own contract. */
  scope: ScopeSchema.optional(),
  extract: z
    .object({
      metaignore: z.string().optional(),
    })
    .default({}),
  migrate: MigrateBlock.optional(),
  /**
   * How a metadata name becomes a physical database name when the metadata gives none
   * (ADR-0058). `columns` applies to a field with no `@column`; `tables` to an object whose
   * source names no table, view or procedure, through the frozen pluralizer. One setting for
   * the PROJECT, read here by every port, because every port reads and writes the one database
   * `meta migrate` created: codegen, migrate, the runtime and verify all resolve through it.
   * Absent means `snake_case` for both, which is what `meta migrate` has always created.
   */
  naming: z
    .object({
      columns: z.enum(COLUMN_NAMING_STRATEGIES as [ColumnNamingStrategy, ...ColumnNamingStrategy[]]).optional(),
      tables: z.enum(TABLE_NAMING_RULES as [TableNamingRule, ...TableNamingRule[]]).optional(),
    })
    .strict()
    .optional(),
  /**
   * The OUTPUT form of a generated REST surface (ADR-0019 Amendment 2). `decimals`: `native`
   * (default; the string the in-process type holds) or `string` (canonical W1 string).
   * `nullMembers`: `native` (default; as stored), `emit` (every declared member, `null` when
   * unset) or `omit` (drop null members) for a value object's members. Input rules do not
   * follow it. Absent means the default for both.
   */
  wire: z
    .strictObject({
      decimals: z.enum(WIRE_DECIMALS as unknown as [WireDecimals, ...WireDecimals[]], {
        message: `"wire.decimals" must be one of ${WIRE_DECIMALS.map((v) => `"${v}"`).join(", ")}`,
      }).optional(),
      nullMembers: z.enum(WIRE_NULL_MEMBERS as unknown as [WireNullMembers, ...WireNullMembers[]], {
        message: `"wire.nullMembers" must be one of ${WIRE_NULL_MEMBERS.map((v) => `"${v}"`).join(", ")}`,
      }).optional(),
    }, {
      error: (iss) => iss.code === "unrecognized_keys"
        ? `"wire" has an unknown key "${iss.keys[0]}" (expected "${WIRE_KEY_DECIMALS}" and/or "${WIRE_KEY_NULL_MEMBERS}")`
        : iss.code === "invalid_type" ? `"wire" must be an object` : undefined,
    })
    .optional(),
  /**
   * C#-scoped settings. `outDir` is where `dotnet meta gen` writes and a bare `dotnet meta
   * verify` diffs, relative to the directory holding `.metaobjects/`; `namespace` is the C#
   * namespace generated types that no package binding places land in. Only the C# port reads
   * them; they are declared here so the shared file validates and this reader does not warn on them.
   */
  csharp: z.strictObject({
    outDir: z.string().min(1).optional(),
    namespace: z.string().min(1).optional(),
  }).optional(),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

/** The physical-naming rules a config declares, each absent rule at its default (ADR-0058). */
export function physicalNamingFromConfig(cfg: Pick<Config, "naming">): PhysicalNaming {
  return {
    columns: cfg.naming?.columns ?? DEFAULT_PHYSICAL_NAMING.columns,
    tables: cfg.naming?.tables ?? DEFAULT_PHYSICAL_NAMING.tables,
  };
}

/** The wire format a config declares, each absent key at its default (ADR-0019 Amendment 2). */
export function wireFormatFromConfig(cfg: Pick<Config, "wire">): WireFormat {
  return {
    decimals: cfg.wire?.decimals ?? DEFAULT_WIRE_FORMAT.decimals,
    nullMembers: cfg.wire?.nullMembers ?? DEFAULT_WIRE_FORMAT.nullMembers,
  };
}

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({ schema_version: 1 });

/** `config.json`'s basename — the single owner. `discovery.ts` and
 *  `collection.ts` import this rather than each keeping their own copy of
 *  the literal (a duplication that had drifted into three separate
 *  declarations of the same string). */
export const CONFIG_FILE = "config.json";

/** Where an unknown-key warning goes. Replaceable so a host can route or capture it. */
let configWarningSink: (message: string) => void = (m) => { process.stderr.write(`${m}\n`); };
const warnedKeys = new Set<string>();

/** Route unknown-key warnings elsewhere (tests, a host with its own logger). Returns the previous sink. */
export function setConfigWarningSink(sink: (message: string) => void): (message: string) => void {
  const previous = configWarningSink;
  configWarningSink = sink;
  return previous;
}

/**
 * Read `.metaobjects/config.json`.
 *
 * FORWARD-TOLERANT at the top level: a key this version does not know is a WARNING, and the
 * key is ignored. The file is shared by every port and by every version in a mixed estate, so
 * a newer MetaObjects adds keys (1.1 added `naming`) that an older reader must not refuse —
 * a 1.0 reader's `.strict()` did exactly that, and the whole load failed on a key that was
 * perfectly valid. A key this version DOES know is still validated strictly, as is everything
 * nested inside it: a typo in `migrate.d1.bindingg` stays an error. The trade is that a
 * misspelled TOP-LEVEL key (`scopes` for `scope`) now warns rather than fails; the warning
 * names it. {@link ConfigSchema} itself stays strict, so `saveConfig` never writes an unknown key.
 */
export async function loadConfig(metaRoot: string): Promise<Config> {
  const path = join(metaRoot, CONFIG_FILE);
  const raw = await readFile(path, "utf8");
  const doc: unknown = JSON.parse(raw);
  const { known, unknownKeys } = splitUnknownTopLevelKeys(doc);
  const result = ConfigSchema.safeParse(known);
  if (!result.success) throw new Error(describeConfigError(path, result.error));
  for (const key of unknownKeys) {
    const id = `${path}\u0000${key}`;
    if (warnedKeys.has(id)) continue;
    warnedKeys.add(id);
    configWarningSink(
      `warning: ${path}: unknown top-level key "${key}" ignored. A newer MetaObjects may have written it; ` +
        `upgrade this tool, or remove the key if it is a misspelling. Known keys: ${CONFIG_TOP_LEVEL_KEYS.join(", ")}.`,
    );
  }
  return result.data;
}

/** The top-level keys this version reads. */
export const CONFIG_TOP_LEVEL_KEYS: readonly string[] = Object.keys(ConfigSchema.shape);

/** Split a parsed config document into the part this version validates and the keys it does not know. */
export function splitUnknownTopLevelKeys(doc: unknown): { known: unknown; unknownKeys: string[] } {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { known: doc, unknownKeys: [] };
  const known: Record<string, unknown> = {};
  const unknownKeys: string[] = [];
  for (const [k, v] of Object.entries(doc)) {
    if (CONFIG_TOP_LEVEL_KEYS.includes(k)) known[k] = v;
    else unknownKeys.push(k);
  }
  return { known, unknownKeys };
}

/**
 * A config error in words: the file, one line per distinct problem, and — for a `sources`
 * entry — the shape that works. Zod's own message is a JSON dump of every union arm, which
 * printed the same issue three times and never named the accepted form.
 */
export function describeConfigError(path: string, error: z.ZodError): string {
  const lines = new Set<string>();
  // zod 4 reports a union arm's issue paths relative to the union, so carry the prefix down.
  const visit = (issues: readonly z.core.$ZodIssue[], prefix: readonly PropertyKey[]): void => {
    for (const issue of issues) {
      const full = [...prefix, ...issue.path];
      if (issue.code === "invalid_union") {
        for (const arm of issue.errors) visit(arm, full);
        continue;
      }
      const at = full.reduce<string>(
        (acc, seg) =>
          typeof seg === "number" ? `${acc}[${seg}]` : acc === "" ? String(seg) : `${acc}.${String(seg)}`,
        "",
      );
      lines.add(`  ${at === "" ? "(top level)" : at}: ${issue.message}`);
    }
  };
  visit(error.issues, []);
  const touchesSources = error.issues.some((i) => i.path[0] === "sources");
  return [
    `${path} is not a valid MetaObjects config:`,
    ...lines,
    ...(touchesSources
      ? ['Each `sources` entry is an object, for example { "path": "model" }, never a bare string.']
      : []),
  ].join("\n");
}

export async function saveConfig(metaRoot: string, config: Config): Promise<void> {
  ConfigSchema.parse(config); // validate before writing
  await writeFile(
    join(metaRoot, CONFIG_FILE),
    JSON.stringify(config, null, 2) + "\n",
    "utf8",
  );
}
