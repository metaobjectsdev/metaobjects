import { docsBlobUrl } from "./docs-ref.js";
import type { MetaData } from "./shared/meta-data.js";
import { TYPE_FIELD } from "./shared/base-types.js";
import { PACKAGE_SEPARATOR } from "./shared/structural.js";
import { FIELD_ATTR_COLUMN, FIELD_ATTR_FLATTENED_COLUMN_PREFIX } from "./persistence/db/db-constants.js";
import {
  SOURCE_ATTR_SCHEMA,
  SOURCE_ROLE_PRIMARY,
} from "./persistence/source/source-constants.js";
import type { MetaSource } from "./persistence/source/meta-source.js";
// isMetaSource, not `instanceof`: unlike the loader-internal validators, the source
// lookups below are EXPORTED helpers that run on a caller-supplied node — migrate-ts
// calls them on nodes the CLI's loader built. Under a split @metaobjectsdev/metadata
// tree the class check would be false for a real primary source, and resolveTableName
// would silently fall through to the entity-name fallback: a DIFFERENT table name,
// which migrate then emits as a rename against a live database. (The same split would
// also make the divergence refusal see no primaries at all, and say nothing.)
import { isMetaSource } from "./shared/node-guards.js";
import { MetaModelError } from "./errors.js";
import { OBJECT_ATTR_COLLECTION_NAME, OBJECT_ATTR_DB_SET_NAME } from "./core/object/object-constants.js";

/**
 * Strip the package prefix from a metadata-qualified name
 * (e.g. "pkg::Name" → "Name"). Returns the input unchanged if no
 * package separator is present. Single canonical helper consumed by
 * both find-reference (cross-entity lookup) and codegen-ts (FQN
 * normalization in generated code).
 */
export function stripPackage(name: string | undefined): string {
  if (!name) return "";
  const idx = name.lastIndexOf(PACKAGE_SEPARATOR);
  return idx === -1 ? name : name.slice(idx + PACKAGE_SEPARATOR.length);
}

/**
 * The package half of a resolution key — the complement of `stripPackage`
 * (`"a::b::C"` → `"a::b"`; a root-level `"C"` → `""`). A resolution key is
 * `package::name` for a packaged node and the bare name otherwise, so the text
 * before the LAST separator is exactly the node's package.
 */
export function packageOfResolutionKey(fqn: string): string {
  const idx = fqn.lastIndexOf(PACKAGE_SEPARATOR);
  return idx === -1 ? "" : fqn.slice(0, idx);
}

export function toSnakeCase(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

export function toKebabCase(s: string): string {
  return toSnakeCase(s).replace(/_/g, "-");
}

/**
 * The `pascal` column rule: the first letter upper-cased, nothing else changed
 * (`createdAt` → `CreatedAt`, `requestURL` → `RequestURL`, `npi` → `Npi`, `address_line1` →
 * `Address_line1`). Not a word split: every other character keeps the case it was written
 * in, so a model maps onto a schema whose columns are its field names with a capital first
 * letter (EF Core's default, for one) with no `@column`. An acronym the database spells in
 * capitals (`NPI`) takes an `@column`, or an application strategy that wraps this one.
 */
export function toPascalColumn(s: string): string {
  // One UTF-16 unit in, one out — as C#'s char.ToUpperInvariant and Java's
  // Character.toUpperCase do — so `ß` (whose JavaScript upper case is "SS") stays `ß` in
  // every port.
  const first = s.charAt(0);
  const upper = first.toUpperCase();
  return (upper.length === 1 ? upper : first) + s.slice(1);
}

/** A naming strategy: a bare metadata name in, a physical name out. */
export type NamingFunction = (name: string) => string;

/** The column rules every port builds in, in the order the conformance corpus lists them. */
export const BUILTIN_COLUMN_NAMING_STRATEGIES = ["snake_case", "literal", "kebab-case", "pascal"] as const;
export type BuiltinColumnNamingStrategy = (typeof BUILTIN_COLUMN_NAMING_STRATEGIES)[number];

/** The table rules every port builds in. */
export const BUILTIN_TABLE_NAMING_RULES = ["snake_case", "literal"] as const;
export type BuiltinTableNamingRule = (typeof BUILTIN_TABLE_NAMING_RULES)[number];

/**
 * How a field with no `@column` becomes a column name: the NAME of a registered column
 * strategy. One project setting, `naming.columns` in `.metaobjects/config.json`, read by
 * every port (ADR-0058): the loaded root carries it ({@link physicalNamingOf}), so codegen,
 * migrate, the runtime and verify resolve the same name. A built-in, or a name the
 * application registered with {@link registerColumnNamingStrategy} (ADR-0058 Amendment 1).
 * Not a metadata attr: `@column` is the per-field override, this is the rule for the rest.
 */
// `string & {}` keeps editor completion for the built-ins while admitting a registered name.
export type ColumnNamingStrategy = BuiltinColumnNamingStrategy | (string & {});

/**
 * How an object with no physical-name attribute (`@table`, `@view`, ...) and no source name
 * gets its table name: the entity (or source) name cased by this rule, the NAME of a
 * registered table rule. The entity-name fallback keeps the frozen legacy pluralizer under
 * every rule ({@link pluralizeTableNameLegacy}).
 */
export type TableNamingRule = BuiltinTableNamingRule | (string & {});

interface NamingRegistry {
  readonly columns: Map<string, NamingFunction>;
  readonly tables: Map<string, NamingFunction>;
  /** rc.19 (R57) — pluralizers, by name: an object name in, its collection name out. */
  collections?: Map<string, NamingFunction>;
}

/** The kinds of naming strategy a project selects in `naming` (ADR-0058; `collections`, R57). */
export type NamingKind = "columns" | "tables" | "collections";

/**
 * One registry per PROCESS, not per module copy. A globally-installed CLI and a project-local
 * dependency are two physical copies of this package (see `shared/node-guards.ts`), and an
 * application's `metaobjects.config.ts` may import the other one: a module-level map would
 * register the strategy in a registry the loader never reads, and the config would be
 * refused as naming an unknown strategy.
 */
const REGISTRY_KEY = Symbol.for("@metaobjectsdev/metadata/naming-strategies");

function registry(): Required<NamingRegistry> {
  const holder = globalThis as { [REGISTRY_KEY]?: NamingRegistry };
  let r = holder[REGISTRY_KEY];
  if (r === undefined) {
    r = { columns: new Map(), tables: new Map() };
    holder[REGISTRY_KEY] = r;
  }
  // A registry an older copy of this package created has no pluralizers yet.
  r.collections ??= new Map();
  // Built-ins are re-seeded on every read, so a registry an older copy of this package
  // created still answers them, and nothing can have replaced one.
  for (const [name, fn] of BUILTIN_COLUMN_FUNCTIONS) if (!r.columns.has(name)) r.columns.set(name, fn);
  for (const [name, fn] of BUILTIN_TABLE_FUNCTIONS) if (!r.tables.has(name)) r.tables.set(name, fn);
  for (const [name, fn] of BUILTIN_PLURALIZERS) if (!r.collections.has(name)) r.collections.set(name, fn);
  return r as Required<NamingRegistry>;
}

const BUILTIN_COLUMN_FUNCTIONS: ReadonlyMap<string, NamingFunction> = new Map<string, NamingFunction>([
  ["snake_case", toSnakeCase],
  ["literal", (name) => name],
  ["kebab-case", toKebabCase],
  ["pascal", toPascalColumn],
]);

const BUILTIN_TABLE_FUNCTIONS: ReadonlyMap<string, NamingFunction> = new Map<string, NamingFunction>([
  ["snake_case", toSnakeCase],
  ["literal", (name) => name],
]);

/**
 * rc.19 (R57) — the pluralizers every port builds in. `standard` is the cross-port rule
 * ({@link pluralize}: already-plural detection, then the suffix rule) every port already applies
 * to REST segments and generated function names; `none` keeps the name as it is (a project whose
 * collections are named like its objects).
 */
export const BUILTIN_PLURALIZER_NAMES = ["standard", "none"] as const;
/** The pluralizer a project gets when `naming.collections` is absent. */
export const DEFAULT_PLURALIZER = "standard";

const BUILTIN_PLURALIZERS: ReadonlyMap<string, NamingFunction> = new Map<string, NamingFunction>([
  ["standard", (name) => pluralize(name)],
  ["none", (name) => name],
]);

/** The port this registry belongs to, as every port's unknown-strategy message names it. */
const NAMING_PORT = "TypeScript";

function builtInsOf(kind: NamingKind): ReadonlyMap<string, NamingFunction> {
  return kind === "columns" ? BUILTIN_COLUMN_FUNCTIONS : kind === "tables" ? BUILTIN_TABLE_FUNCTIONS : BUILTIN_PLURALIZERS;
}

function register(kind: NamingKind, name: string, apply: NamingFunction): void {
  const builtIns = builtInsOf(kind);
  if (typeof name !== "string" || name === "") {
    throw new MetaModelError(`a ${kindLabel(kind)} strategy needs a non-empty name`);
  }
  if (builtIns.has(name)) {
    throw new MetaModelError(
      `"${name}" is a built in ${kindLabel(kind)} strategy and cannot be replaced; register yours under another name`,
    );
  }
  if (typeof apply !== "function") {
    throw new MetaModelError(`${kindLabel(kind)} strategy "${name}" must be a function from a name to a name`);
  }
  // Registering a name again replaces it: an application registers once at startup, and a
  // config module loaded twice in one process must not fail the second time.
  registry()[kind].set(name, apply);
}

function kindLabel(kind: NamingKind): string {
  return kind === "columns" ? "column-naming" : kind === "tables" ? "table-naming" : "collection-naming (pluralizer)";
}

/**
 * Register a named column strategy (ADR-0058 Amendment 1). `.metaobjects/config.json` then
 * selects it as `"naming": { "columns": "<name>" }`, exactly as it selects a built-in. Register
 * BEFORE the config is read: `meta` commands register `namingStrategies` from
 * `metaobjects.config.ts` first; a program calling `loadMemory` registers before it. Wrapping a
 * built-in is one line: `registerColumnNamingStrategy("x", (n) => ... columnNamingStrategy("pascal")(n))`.
 * A built-in name cannot be replaced; registering a name of your own again replaces it.
 */
export function registerColumnNamingStrategy(name: string, apply: NamingFunction): void {
  register("columns", name, apply);
}

/** Register a named table rule (ADR-0058 Amendment 1); see {@link registerColumnNamingStrategy}. */
export function registerTableNamingRule(name: string, apply: NamingFunction): void {
  register("tables", name, apply);
}

/**
 * Register a named pluralizer (rc.19, R57): an object name (Pascal, as declared) in, its
 * collection name out. `.metaobjects/config.json` selects it as `"naming": { "collections":
 * "<name>" }`; an object's own `@collectionName` always wins over it. A built-in (`standard`,
 * `none`) cannot be replaced; registering a name of your own again replaces it.
 */
export function registerPluralizer(name: string, apply: NamingFunction): void {
  register("collections", name, apply);
}

/** Every registered pluralizer's name: the built-ins, then the application's. */
export function registeredPluralizers(): readonly string[] {
  return [...registry().collections.keys()];
}

/** True when `name` is a registered pluralizer, built in or the application's. */
export function isRegisteredPluralizer(name: string): boolean {
  return registry().collections.has(name);
}

/** The pluralizer registered as `name`. Throws, naming it, when nothing answers it. */
export function pluralizer(name: string): NamingFunction {
  const fn = registry().collections.get(name);
  if (fn === undefined) throw new MetaModelError(unknownNamingStrategyMessage("collections", name));
  return fn;
}

/** Every registered column strategy's name: the built-ins in corpus order, then the application's. */
export function registeredColumnNamingStrategies(): readonly string[] {
  return [...registry().columns.keys()];
}

/** Every registered table rule's name: the built-ins, then the application's. */
export function registeredTableNamingRules(): readonly string[] {
  return [...registry().tables.keys()];
}

/**
 * What every port says when a config (or a caller) names a strategy no registered strategy
 * answers. Same words in every port, with that port's name, so an estate running several
 * ports sees one message and knows which port's registry lacked it.
 */
export function unknownNamingStrategyMessage(kind: NamingKind, name: string): string {
  const builtIns: readonly string[] = [...builtInsOf(kind).keys()];
  const registered = [...registry()[kind].keys()].filter((n) => !builtIns.includes(n));
  return (
    `"naming.${kind}" names "${name}", which no ${kindLabel(kind)} strategy registered in the ` +
    `${NAMING_PORT} port answers (built in: ${builtIns.join(", ")}; registered by the application: ` +
    `${registered.length === 0 ? "none" : registered.join(", ")}). Register it before ` +
    `.metaobjects/config.json is read, or correct the name.`
  );
}

/** The column strategy registered as `name`. Throws, naming it, when nothing answers it. */
export function columnNamingStrategy(name: string): NamingFunction {
  const fn = registry().columns.get(name);
  if (fn === undefined) throw new MetaModelError(unknownNamingStrategyMessage("columns", name));
  return fn;
}

/** The table rule registered as `name`. Throws, naming it, when nothing answers it. */
export function tableNamingRule(name: string): NamingFunction {
  const fn = registry().tables.get(name);
  if (fn === undefined) throw new MetaModelError(unknownNamingStrategyMessage("tables", name));
  return fn;
}

/**
 * TEST-ONLY: forget every strategy the application registered, leaving the built-ins. The
 * registry is process-wide (and shared by every copy of this package), so a test that registers
 * one resets it when it is done rather than leaving it for the next test to find. Not for
 * production code.
 */
export function resetNamingStrategiesForTesting(): void {
  const r = registry();
  for (const name of [...r.columns.keys()]) if (!BUILTIN_COLUMN_FUNCTIONS.has(name)) r.columns.delete(name);
  for (const name of [...r.tables.keys()]) if (!BUILTIN_TABLE_FUNCTIONS.has(name)) r.tables.delete(name);
  for (const name of [...r.collections.keys()]) if (!BUILTIN_PLURALIZERS.has(name)) r.collections.delete(name);
}

/** True when `name` is a registered column strategy, built in or the application's. */
export function isRegisteredColumnNamingStrategy(name: string): boolean {
  return registry().columns.has(name);
}

/** True when `name` is a registered table rule, built in or the application's. */
export function isRegisteredTableNamingRule(name: string): boolean {
  return registry().tables.has(name);
}

/**
 * Every BUILT-IN column rule, in the order the conformance corpus lists them. The registry
 * ({@link registeredColumnNamingStrategies}) is the full set a config may name.
 */
export const COLUMN_NAMING_STRATEGIES: readonly ColumnNamingStrategy[] = BUILTIN_COLUMN_NAMING_STRATEGIES;

/** The default in EVERY port: what `meta migrate` has always created. */
export const DEFAULT_COLUMN_NAMING_STRATEGY: ColumnNamingStrategy = "snake_case";

/** Every BUILT-IN table rule; see {@link registeredTableNamingRules} for the full set. */
export const TABLE_NAMING_RULES: readonly TableNamingRule[] = BUILTIN_TABLE_NAMING_RULES;

/** The project's physical-naming rules: `naming` in `.metaobjects/config.json` (ADR-0058). */
export interface PhysicalNaming {
  readonly columns: ColumnNamingStrategy;
  readonly tables: TableNamingRule;
  /** rc.19 (R57) — the pluralizer an object without `@collectionName` takes its collection name
   *  from (`naming.collections`). Not a physical name; it rides here because it is the same
   *  project setting, read the same way. Absent is {@link DEFAULT_PLURALIZER}. */
  readonly collections?: string;
}

/** The default in every port, equal to what `meta migrate` has always created. */
export const DEFAULT_PHYSICAL_NAMING: PhysicalNaming = Object.freeze({
  columns: DEFAULT_COLUMN_NAMING_STRATEGY,
  tables: "snake_case",
});

/**
 * The physical-naming rules for the tree `node` belongs to: what its root carries, set by the
 * project-aware load from `.metaobjects/config.json`, else {@link DEFAULT_PHYSICAL_NAMING}.
 * Read through the root, not passed around, so every consumer of one loaded model resolves
 * the same physical names.
 */
export function physicalNamingOf(node: MetaData): PhysicalNaming {
  const naming = (node.root() as { physicalNaming?: PhysicalNaming }).physicalNaming;
  return naming ?? DEFAULT_PHYSICAL_NAMING;
}

/** The migration guide every refusal of a former naming source names (ADR-0058). */
export const PHYSICAL_NAMING_MIGRATION_GUIDE_PATH = "docs/features/migrations/physical-naming.md";

/** The guide on `main`: the default when a caller has no release to pin to. */
export const PHYSICAL_NAMING_MIGRATION_GUIDE = docsBlobUrl(PHYSICAL_NAMING_MIGRATION_GUIDE_PATH);

/**
 * What a former column-naming source prints when it is still used (ADR-0058): the one
 * setting, where it goes, and the guide. Same words in every port. `what` names the source
 * exactly; `value` is the rule it gave, carried into the example so the move is mechanical.
 */
export function physicalNamingRemovedMessage(
  what: string,
  value: string = "literal",
  guide: string = PHYSICAL_NAMING_MIGRATION_GUIDE,
): string {
  return (
    `${what} was removed in 1.1.0. Column and table naming is one project setting now, read by ` +
    `every port: "naming" in .metaobjects/config.json, for example "naming": { "columns": "${value}" }. ` +
    `Move it there and delete ${what}. See ${guide}`
  );
}

/** `name` cased by the table rule registered as `rule`. Throws on a name nothing registered. */
export function applyTableNamingRule(name: string, rule: TableNamingRule): string {
  return tableNamingRule(rule)(name);
}

/**
 * `name` through the column strategy registered as `strategy`: the ONE door every column
 * resolution goes through (codegen, migrate, the runtime, verify, the view and docs
 * generators), so an application's strategy reaches all of them. Throws on a name nothing
 * registered: never a silent fallback to the default, which would bind a whole schema to
 * the wrong columns and report success.
 */
export function applyColumnNamingStrategy(name: string, strategy: ColumnNamingStrategy): string {
  return columnNamingStrategy(strategy)(name);
}

/** The four letters that precede a genuinely SINGULAR "...s" ending in the common
 *  patterns this codebase's entity names hit — Status, Address, Bonus, Alias, Gas,
 *  Analysis. Anything else before a final "s" reads as already-plural. */
const ALREADY_PLURAL_EXCLUDED_PRECEDING_CHARS = new Set(["s", "u", "i", "a"]);

/**
 * True when `s` already reads as a plural noun, so running it through the ordinary
 * suffix rule would double it — the real defect this file exists to fix:
 * `ProgramPurchaseStats` → `ProgramPurchaseStatses` shipped as six REST collection
 * paths and TanStack hook names in an adopter's app.
 *
 * Heuristic, not a dictionary: a word ending in "s" is already-plural UNLESS the
 * character immediately before that final "s" is one of s/u/i/a (case-insensitive).
 * Covers Stats, Settings, Details, News, Analytics, Series, Photos; leaves Status,
 * Address, Bonus, Alias, Gas, Analysis on the ordinary suffix path (unchanged).
 *
 * Known miss, deliberately not fixed here: a genuinely singular word ending in
 * "...s" with none of those four letters before it reads as already-plural too —
 * `Lens` → `Lens` (correct plural `Lenses`). Fixing that needs a real dictionary,
 * which this function is not; the heuristic optimizes for the shape the doubling
 * defect actually hits (entity names that are already a plural concept).
 */
function isAlreadyPlural(s: string): boolean {
  if (!/s$/i.test(s) || s.length < 2) return false;
  return !ALREADY_PLURAL_EXCLUDED_PRECEDING_CHARS.has(s[s.length - 2]!.toLowerCase());
}

/**
 * FROZEN — byte-for-byte the pre-fix suffix-only pluralization rule, with no
 * already-plural detection. This is the DEFAULT PHYSICAL NAME derivation only:
 * `resolveTableName`'s no-source fallback and `MetaSource.physicalName`'s step-4
 * owner-name fallback, both reached only when metadata declares no explicit
 * physical name. An adopter's live database was created with this rule; changing
 * it would make `meta migrate` propose a rename for every already-plural entity
 * name on the next run. Never call this for an API/code-surface name (REST paths,
 * generated hook/query/finder/list names, DbSet/collection variable names) — those
 * go through {@link pluralize}, which fixes the doubling this function
 * deliberately still has.
 */
export function pluralizeTableNameLegacy(s: string): string {
  if (/(s|x|z|ch|sh)$/i.test(s)) return s + "es";
  if (/[^aeiou]y$/i.test(s)) return s.slice(0, -1) + "ies";
  return s + "s";
}

/**
 * API/code-surface pluralization: REST collection/route paths, entity-descriptor
 * URLs, generated hook/query/finder/list function names, DbSet/collection names —
 * every generator-facing use. Adds already-plural detection ({@link isAlreadyPlural})
 * on top of the historical suffix rule ({@link pluralizeTableNameLegacy}).
 *
 * NOT for default physical table/column name derivation — that fallback is frozen
 * (see `pluralizeTableNameLegacy`) so an existing adopter database never sees a
 * proposed rename.
 */
export function pluralize(s: string): string {
  if (isAlreadyPlural(s)) return s;
  return pluralizeTableNameLegacy(s);
}

/**
 * rc.19 (R57) — an object's collection name, in the object's own casing: its own
 * `@collectionName` (or the deprecated `@dbSetName` alias), else the project's pluralizer
 * (`naming.collections`, {@link physicalNamingOf}) over its name. Each artifact then applies its
 * own casing (REST: snake_case; a TS export: as is; a Drizzle variable: lowerFirst). Own, not
 * resolving: a name inherited from an abstract base would give every subtype one collection.
 * Throws when an object declares both attrs — the caller reports it.
 */
export function collectionNameOf(obj: MetaData): string {
  const declared = declaredCollectionName(obj);
  if (declared !== undefined) return declared.name;
  return pluralizer(physicalNamingOf(obj).collections ?? DEFAULT_PLURALIZER)(obj.name);
}

/**
 * rc.19 fix round (I3) — the REST collection segment an object is served under: {@link
 * collectionSegmentOf} over its name, its declared collection name and the project's
 * `naming.collections`. Every port's routes, `$path`, OpenAPI and docs REST paths read it.
 */
export function collectionSegment(obj: MetaData): string {
  return collectionSegmentOf(obj.name, declaredCollectionName(obj)?.name, physicalNamingOf(obj).collections);
}

/**
 * The REST collection segment for an object named `name` (`fixtures/naming-conformance/
 * collection-segments.json`, shared with C#):
 *   - a declared `@collectionName` wins, snake_cased ({@link snakeCollectionName});
 *   - else a configured pluralizer's output over the name, snake_cased the same way;
 *   - else the historical rule, byte-identical to rc.18: snake_case, then {@link pluralize}.
 * A pluralizer is applied only when the project configures one, so an unconfigured project's
 * segments never move (`FAQ` stays `faqs`, never `fa_qs`).
 */
export function collectionSegmentOf(name: string, declared?: string, configuredPluralizer?: string): string {
  if (declared !== undefined) return snakeCollectionName(declared);
  if (configuredPluralizer !== undefined) return snakeCollectionName(pluralizer(configuredPluralizer)(name));
  return pluralize(toSnakeCase(name));
}

/**
 * snake_case a collection name with an acronym-aware split: a trailing plural `s` / `es` after a
 * capital is a suffix of the acronym, not a word of its own (`FAQs` -> `faqs`, `TaxIDs` ->
 * `tax_ids`, `PDFBoxes` -> `pdf_boxes`). Any other name is {@link toSnakeCase}.
 */
export function snakeCollectionName(s: string): string {
  const m = /^(.*[A-Z])(e?s)$/.exec(s);
  return m !== null ? toSnakeCase(m[1]!) + m[2]! : toSnakeCase(s);
}

/**
 * The collection name an object declares itself, and through which attr; undefined when it
 * declares none. Refuses both at once: an alias and its replacement disagreeing has no answer.
 */
export function declaredCollectionName(obj: MetaData): { name: string; deprecatedAlias: boolean } | undefined {
  const own = obj.ownAttr(OBJECT_ATTR_COLLECTION_NAME);
  const alias = obj.ownAttr(OBJECT_ATTR_DB_SET_NAME);
  const hasOwn = typeof own === "string" && own !== "";
  const hasAlias = typeof alias === "string" && alias !== "";
  if (hasOwn && hasAlias) {
    throw new MetaModelError(
      `${obj.resolutionKey()}: declares both @${OBJECT_ATTR_COLLECTION_NAME} and @${OBJECT_ATTR_DB_SET_NAME}; ` +
        `@${OBJECT_ATTR_DB_SET_NAME} is a deprecated alias of @${OBJECT_ATTR_COLLECTION_NAME} — keep only @${OBJECT_ATTR_COLLECTION_NAME}.`,
    );
  }
  if (hasOwn) return { name: own as string, deprecatedAlias: false };
  if (hasAlias) return { name: alias as string, deprecatedAlias: true };
  return undefined;
}

/**
 * THE `@role: primary` source lookup for this package — and the one place the
 * primary-source DIVERGENCE refusal lives, so that every caller inherits it.
 *
 * Effective children (own + inherited via the super chain) so a TPH SUBTYPE —
 * which declares no source of its own and inherits the discriminator base's
 * single table (FR-017) — resolves to that base source rather than to nothing.
 * For an entity declaring its own source, own shadows inherited, so the result
 * is unchanged. Returns `undefined` when `entity` declares no primary source at
 * all: #248, participation in persistence derives from a declared source, never
 * from the object subtype, so an `object.value` and a sourceless
 * `object.projection` both land here rather than being special-cased.
 *
 * `isMetaSource`, not `instanceof`: under two physical copies of this package a
 * class check is false for a real primary source, and the failure is SILENT —
 * the object reads as "not backed by any store".
 *
 * ## The refusal
 *
 * An object whose `@role: primary` sources resolve to MORE THAN ONE physical
 * ADDRESS has no single answer to give, so this throws rather than picking one.
 * The address is `(kind, schema, physical name)` — see `sourceAddressKey`. It was
 * once the bare physical name, which was a WEAKER key than any consumer's: migrate
 * keys every table it compares by schema-or-default + name, Postgres DDL is
 * `CREATE TABLE "s"."t"`, and since 0.25.0 generated code binds the schema half too
 * (`pgSchema(...).table(...)`, `[Table(..., Schema = ...)]`). Two primaries agreeing
 * on `@table` and disagreeing on `@schema` therefore passed here and were refused by
 * the names artifact, so `meta gen` failed on a model every other door admitted.
 *
 * What decided it was not the asymmetry but WHICH source the weaker key returned:
 * `primaries[0]` is the INHERITED source in TS/C#/Python (`children()` puts the
 * super's entries first) and the OWN source on the JVM, so such a model silently
 * bound one schema in three ports and the other in two — one document, two verdicts
 * depending on which toolchain read it.
 * The shape loads with ZERO errors: `validateSourceRoles` enforces "exactly one
 * primary" over `ownChildren()` only, and `_effectiveChildren` shadows an own
 * child over a super child only on a (type, name) match — so two `source.rdb`
 * nodes with DIFFERENT explicit names at two levels of an `extends` chain never
 * collide, and both land on the child's effective `children()`.
 *
 * It lives HERE rather than in any one consumer because every consumer binds
 * ONE name unconditionally. It used to live only in codegen-ts's
 * `resolveObjectNames`, which runs only when the `names` generator is in the
 * run — so with `namesFile()` unwired `meta migrate` emitted DDL against the
 * PARENT's table (via `resolveTableName` → `buildExpectedSchema`) and
 * `ObjectManager` read and wrote it, silently, on every run. A refusal that
 * depends on which consumer asked is not a refusal. Mirrors Python's
 * `source_resolution.primary_rdb_source`, whose codegen, api-docs and runtime
 * callers all inherit it for free.
 *
 * DIRECTION-BLIND: it compares every primary against every other, so it does
 * not matter which of them is writable nor which was declared first. Comparing
 * against the first primary WRITABLE source can only see a divergence when one
 * of the two is read-only — and, since `children()` places inherited entries
 * first, only when the read-only one is the inherited one.
 *
 * Two primaries AGREEING on an address is not a divergence and stays legal: the
 * invariant is that an object has ONE address, not that it declares one source.
 * A read-only primary beside a non-primary REPLICA does not reach it either — a
 * replica is not `role === "primary"`.
 */
export function sourceAddressKey(source: MetaSource): string {
  // The RESOLVED address, and the same three parts the names artifact compares — so the
  // shared authority and the generated artifact cannot answer "is this one object?"
  // differently. Rendered rather than structural because every port has to produce a
  // byte-identical message from it.
  //
  // RAW, deliberately: an absent `@schema` is NOT folded into a dialect default. On
  // Postgres absent and "public" address the same relation, but on SQLite/D1 they do
  // not — `migrate-ts`'s expected-schema builder throws on ANY declared schema, "public"
  // included, while an absent one is fine. `resolveTableSchema` already documents that
  // deciding what "undefined" means belongs to the caller's dialect, not to this layer,
  // so normalizing here would import one dialect's rule into a dialect-free tier.
  const schema = source.attr(SOURCE_ATTR_SCHEMA);
  const qualifier = typeof schema === "string" && schema !== "" ? `"${schema}".` : "";
  return `${qualifier}"${source.physicalName}" (${source.effectiveKind})`;
}

export function primaryRdbSource(entity: MetaData): MetaSource | undefined {
  const primaries = entity.children().filter(
    (c): c is MetaSource => isMetaSource(c) && c.role === SOURCE_ROLE_PRIMARY,
  );
  if (primaries.length === 0) return undefined;
  const distinct = [...new Set(primaries.map(sourceAddressKey))].sort();
  if (distinct.length > 1) {
    // Sorted, so the message is identical in every port regardless of children() order.
    const joined = distinct.join(" vs ");
    throw new MetaModelError(
      `${entity.name}: role=primary sources disagree on the object's physical address — ` +
      `${joined}. Every consumer binds ONE address. Give them a matching @kind, @schema ` +
      `and physical name, or drop the extra role=primary declaration.`,
    );
  }
  return primaries[0];
}

export function resolveTableName(entity: MetaData): string {
  // FR-016: primary source's `physicalName` implements the four-step rule
  // (kind-matching alias → legacy @table → source.name → entity-name fallback),
  // so this helper now just delegates. Writability (table vs view/storedProc/
  // tableFunction) only affects write-routing — for SELECT-side name resolution,
  // a read-only primary source is the right answer.
  const source = primaryRdbSource(entity);
  if (source !== undefined) return source.physicalName;
  // Frozen: this is a DEFAULT PHYSICAL name, not an API-surface name. See
  // pluralizeTableNameLegacy's doc. Cased by the project's table rule (ADR-0058).
  return pluralizeTableNameLegacy(applyTableNamingRule(entity.name, physicalNamingOf(entity).tables));
}

export function resolveColumnName(
  field: MetaData,
  strategy: ColumnNamingStrategy = physicalNamingOf(field).columns,
): string {
  // ADR-0039: resolving — a concrete field may inherit @column via extends.
  const col = field.attr(FIELD_ATTR_COLUMN);
  if (typeof col === "string" && col) return col;
  return applyColumnNamingStrategy(field.name, strategy);
}

/**
 * The text before each member's column when `field` (a `field.object @storage "flattened"`)
 * expands its value object into the owning table: its `@flattenedColumnPrefix` verbatim (`""` allowed),
 * else its own resolved column and `_`. With `@column: "bill"` the members are
 * `bill_<member column>`; under the `pascal` rule an `address` field gives `Address_`,
 * which is EF Core's owned-type default.
 *
 * Core naming, not migrate's: generated ORM mappings (the Prisma schema, the C# EF mapping,
 * the Kotlin Exposed tables) address these columns too, and must spell them exactly as the
 * migration creates them.
 * ADR-0039: resolving — `@flattenedColumnPrefix` and `@column` may be inherited through `extends`.
 */
export function resolveFlattenedColumnPrefix(
  field: MetaData,
  strategy: ColumnNamingStrategy = physicalNamingOf(field).columns,
): string {
  const prefix = field.attr(FIELD_ATTR_FLATTENED_COLUMN_PREFIX);
  if (typeof prefix === "string") return prefix;
  return resolveColumnName(field, strategy) + "_";
}

/**
 * The column a member of a flattened value object gets in the owning table: the embedding
 * field's {@link resolveFlattenedColumnPrefix} followed by the member's own resolved column
 * (its `@column`, else its name under the rule).
 */
export function resolveFlattenedColumnName(
  field: MetaData,
  member: MetaData,
  strategy: ColumnNamingStrategy = physicalNamingOf(field).columns,
): string {
  return resolveFlattenedColumnPrefix(field, strategy) + resolveColumnName(member, strategy);
}

/**
 * An index's DATABASE name — for an `identity.secondary` (a unique alternate key) or an
 * `index.lookup` (a non-unique retrieval index).
 *
 * These nodes carry no `@column`-style physical spelling: the database name IS the
 * metamodel `name`. That is precisely why the answer must live in a function rather than
 * at each call site. It was spelled independently in three places — the Drizzle emitter,
 * migrate's expected-schema (twice) and the Kotlin Exposed emitter — and agreed only by
 * coincidence; `fdb4118f1` is what that coincidence lapsing looks like, with codegen
 * declaring `idx_<table>_<col>` while the index in the database was `identity.name`.
 *
 * Two rules the single door now owns, neither of which any call site had:
 *
 * - **Package qualifier stripped — and the reason first given for this was WRONG.** It was
 *   justified here as compensating for the JVM loader package-qualifying a nested index
 *   name (`acme::demo::by_name`), which `KotlinExposedTableGenerator` mirrored with
 *   `shortName ?: name`. Measured against the real JVM loader, that does not happen: a
 *   nested `identity.secondary` or `index.lookup` is named flat, including when inherited
 *   across packages via `extends`. Only a ROOT-level node takes the file's package, and an
 *   unnamed `view` child gets a synthesised FQN — the likeliest source of the belief. The
 *   JVM's local strip had been a no-op for its whole life while reading as the site that
 *   owned the rule. Pinned now on that side by `IndexNamingTest`.
 *
 *   The strip stays, on the honest reason rather than the invented one: it is a no-op on
 *   every name either loader produces, which is what a rule that holds without a per-port
 *   branch looks like, and it costs one `lastIndexOf`. A normalisation nobody has to
 *   remember is worth more than a claim nobody checked.
 * - **An empty name is REFUSED**, and the gap it closes is exactly one node type wide.
 *   An `identity.secondary` with an empty name is already refused by the LOADER in strict
 *   and lax mode alike (identity nodes carry an FR-024 name check so a dotted `extends`
 *   ref can address them). An `index.lookup` is not addressable that way and carries no
 *   such check, so `{"index.lookup": {"name": ""}}` loads with zero errors in both modes
 *   and reaches the emitters, which produce `index("")`: SQL no engine accepts, from a
 *   model that passed every gate. Refusing at the shared door closes it for codegen and
 *   migrate at once, without touching the byte-gated registry `rules` prose a loader-side
 *   fix would need. Measured, not assumed — `resolve-index-name.test.ts` asserts both
 *   arms, because "the loader already handles it" is the belief that would delete this.
 */
export function resolveIndexName(
  // The narrow structural shape rather than `MetaData`: this reads three properties, and
  // every caller that has a real node satisfies it, while the Drizzle emitter's local
  // duck-typed index node does not need a cast to pass one. A cast here would be the
  // usual way a `never` slips past the compiler into a runtime property read.
  node: { readonly name: string; readonly type: string; readonly subType: string },
): string {
  const short = stripPackage(node.name);
  if (short === "") {
    throw new MetaModelError(
      `${node.type}.${node.subType} declares an empty name; an index's database name IS ` +
      `its metamodel name, so there is nothing to emit. Give it a name.`,
    );
  }
  return short;
}

/**
 * Returns the DB schema declared on an entity's primary source child, or undefined
 * when no @schema attr is set or no source child exists. @schema is paradigm-agnostic
 * (works for writable tables and read-only views/projections alike). Callers decide what
 * "undefined" means for their dialect — Postgres treats it as the default public schema,
 * SQLite treats it as the only allowed value (no schema concept).
 */
export function resolveTableSchema(entity: MetaData): string | undefined {
  // ADR-0039: resolving — a concrete entity may inherit its source.rdb via extends.
  // primaryRdbSource, not a second hand-rolled scan: a lookup written twice is a
  // lookup that can disagree with itself, and only one of the two copies would
  // carry the divergence refusal.
  const source = primaryRdbSource(entity);
  if (!source) return undefined;
  // ADR-0039: resolving — an inherited source's @schema lives on the super node.
  const schema = source.attr(SOURCE_ATTR_SCHEMA);
  if (typeof schema === "string" && schema !== "") return schema;
  return undefined;
}

/** Per-entity {jsName ↔ dbColumn} map. Built once per entity to avoid re-walking children on every row. */
export interface EntityNameMap {
  jsToDb: Map<string, string>;
  dbToJs: Map<string, string>;
}

export function buildNameMap(
  entity: MetaData,
  strategy: ColumnNamingStrategy = physicalNamingOf(entity).columns,
): EntityNameMap {
  const jsToDb = new Map<string, string>();
  const dbToJs = new Map<string, string>();
  // Effective children so a TPH subtype's name map covers inherited base
  // fields + its own (FR-017); own shadows inherited on a name conflict.
  for (const child of entity.children()) {
    if (child.type !== TYPE_FIELD) continue;
    const dbCol = resolveColumnName(child, strategy);
    jsToDb.set(child.name, dbCol);
    dbToJs.set(dbCol, child.name);
  }
  return { jsToDb, dbToJs };
}
