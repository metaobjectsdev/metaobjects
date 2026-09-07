/**
 * §A2/§A3 — the ONE place a data name is resolved for a generator run.
 *
 * Both the names artifact (namesFile) and the entity generator that consumes it call this,
 * so the constant and the binding it describes cannot be produced by different resolvers or
 * different arguments. That is the whole rule; a name computed twice is a name that can
 * disagree with itself.
 */
import {
  primaryRdbSource,
  resolveColumnName,
  resolveIndexName,
  resolveTableSchema,
  isMetaObject,
  isMetaSource,
  PHYSICAL_NAME_ATTR_BY_KIND,
  SOURCE_ATTR_SCHEMA,
  SOURCE_ROLE_PRIMARY,
  TYPE_INDEX,
  TYPE_OBJECT,
  TYPE_SOURCE,
  type ColumnNamingStrategy,
  type MetaObject,
  type MetaSource,
} from "@metaobjectsdev/metadata";
import { code, imp, type Code } from "ts-poet";
import { crossEntitySpecifier } from "./import-path.js";
import type { RenderContext } from "./render-context.js";

export interface FieldNames { readonly name: string; readonly column: string; }

/**
 * One `source.rdb` child, under the ROLE it plays.
 *
 * The physical name is carried under a key NAMED FOR THE KIND — `table`, `view`,
 * `materializedView`, `proc`, `function` — and that key is not invented here: it is
 * `PHYSICAL_NAME_ATTR_BY_KIND`, the metamodel's own FR-016/ADR-0018 alias map, the same
 * one the canonical serializer rewrites through. So the artifact spells a physical name
 * the way the metadata that declared it does.
 *
 * This is the half of the shape that earns the restructure. A single flat `name` held a
 * table, a view and a stored procedure in the same run, told apart only by a sibling
 * `kind`; under `as const`, `LedgerNames.sources.replica.table` is now a compile error,
 * because that source is a view. The read site answers the question instead of the reader
 * having to.
 */
export interface SourceNames {
  readonly type: string;
  readonly subType: string;
  /** The `@kind` value, defaulted per ADR-0007 Rule 3 — the discriminator for the alias below. */
  readonly kind: string;
  readonly schema?: string | undefined;
  /** The physical name, under the alias for `kind`. Exactly one of these is present. */
  readonly table?: string | undefined;
  readonly view?: string | undefined;
  readonly materializedView?: string | undefined;
  readonly proc?: string | undefined;
  readonly function?: string | undefined;
}

/**
 * One `identity.*` or `index.*` child.
 *
 * `subType` is load-bearing rather than decorative: it is the ONLY thing distinguishing a
 * unique alternate key from a non-unique lookup index, which is the whole reason ADR-0040
 * put uniqueness in the type rather than in an attribute.
 *
 * `index` — the database name — is present only where a shared resolver produces it:
 * `identity.secondary` and `index.lookup`, via `resolveIndexName`. It is deliberately
 * ABSENT on `identity.primary`, because no such name exists to carry: migrate hardcodes
 * `<table>_pkey` on Postgres, emits an unnamed PK on SQLite, and no port's codegen names a
 * primary key at all. Carrying it would restate a migrate-only, dialect-conditional
 * formula in an artifact whose entire promise is that a name is spelled once — the #293
 * defect, re-created by the mechanism built to prevent it.
 */
export interface KeyNames {
  readonly type: string;
  readonly subType: string;
  readonly name: string;
  /** The database index name. Present for `identity.secondary` and `index.lookup` only. */
  readonly index?: string | undefined;
}

/** The object whose names artifact this one extends. */
export interface SuperNames {
  readonly name: string;
  readonly package?: string | undefined;
}

export interface ObjectNames {
  /** The metamodel type — always `object`. */
  readonly type: string;
  /** The metamodel subType — `entity` | `projection` | `value`. */
  readonly subType: string;
  /**
   * The object's OWN name — `"Customer"`, not `"TBL_CUST_MASTER"`.
   *
   * It held the physical name until 0.25.0, which is the one change here that a hand-
   * written consumer can adopt WITHOUT a compile error: `pgTable(CustomerNames.name, …)`
   * still compiles and now binds a table called `Customer`. The release note leads with
   * that; no gate here can see it, because the code that breaks is not generated.
   */
  readonly name: string;
  /**
   * Every `source.rdb` child, keyed by effective `@role` (`primary` | `replica`).
   *
   * Role is the honest axis: the loader requires exactly one primary, and every consumer
   * that binds a second source picks it by role. Keying by role is also what finally gives
   * a WRITE-THROUGH entity's replica view a home — it declares two physical names, the
   * artifact carried one, and both TypeScript and C# emitted the second as a literal.
   *
   * Empty on a FRAGMENT: an abstract base with no source of its own contributes columns
   * and must never acquire a physical name it never declared.
   */
  readonly sources: Readonly<Record<string, SourceNames>>;
  /** The sources DECLARED HERE — what this artifact emits. See `ownFields`. */
  readonly ownSources: Readonly<Record<string, SourceNames>>;
  /**
   * Every field, INHERITED INCLUDED. This is what a consumer looks a column up in, so a
   * lookup for an inherited field must hit — miss and the caller falls back to a literal
   * (see `columnExpr`), which is the whole defect this artifact exists to remove.
   */
  readonly fields: Readonly<Record<string, FieldNames>>;
  /**
   * The fields DECLARED HERE — what the artifact EMITS. Inherited ones are declared by
   * the super's artifact and reached through it, so a subtype states each physical name
   * once instead of restating its parent's.
   *
   * ADR-0039's ONE sanctioned own-accessor use, in the exact form the ADR names: codegen
   * emitting a generated subclass, iterating own members so inherited ones are not
   * re-emitted.
   */
  readonly ownFields: Readonly<Record<string, FieldNames>>;
  /** Every `identity.*` child, inherited included; keyed by metamodel name. */
  readonly identities: Readonly<Record<string, KeyNames>>;
  /** The identities DECLARED HERE. See `ownFields`. */
  readonly ownIdentities: Readonly<Record<string, KeyNames>>;
  /** Every `index.*` child, inherited included; keyed by metamodel name. */
  readonly indexes: Readonly<Record<string, KeyNames>>;
  /** The indexes DECLARED HERE. See `ownFields`. */
  readonly ownIndexes: Readonly<Record<string, KeyNames>>;
  /** The nearest ancestor carrying an artifact of its own, when there is one. */
  readonly superNames?: SuperNames | undefined;
  /**
   * True when the primary source is the SUPER's rather than declared here — a TPH
   * subtype, which shares its base's single table. Structural (the two resolve to the
   * SAME source node), never an equality test on the resolved strings: the physical
   * name, kind and schema then all come from the super's artifact rather than being
   * restated.
   */
  readonly inheritsSource: boolean;
}

/**
 * One source node's names, keyed by the metamodel's own kind→alias map.
 *
 * `readOnly` is deliberately NOT carried, and its removal is the shape's own rule applied
 * to itself: it is not metadata at all but a derivation over `@kind` (`source.isReadOnly()`),
 * and a sweep of all five ports found ZERO consumers, generated or hand-written. An
 * artifact that mirrors the metadata tree carries what was declared; a reader who wants
 * read-only-ness asks `kind`, which is the thing the author actually wrote.
 */
function sourceNamesOf(source: MetaSource): SourceNames {
  const kind = source.effectiveKind;
  // The metamodel's map, never a local switch: a sixth @kind must not need an edit here to
  // be spelled correctly, and a local copy is a second answer to a question that has one.
  const alias = PHYSICAL_NAME_ATTR_BY_KIND.get(kind);
  const schema = source.attr(SOURCE_ATTR_SCHEMA);
  return {
    type: TYPE_SOURCE,
    subType: source.subType,
    kind,
    ...(typeof schema === "string" && schema !== "" ? { schema } : {}),
    ...(alias === undefined ? {} : { [alias]: source.physicalName }),
  };
}

/** Every `source.rdb` child of `obj`, keyed by effective role. */
function sourcesOf(sources: readonly MetaSource[], where: string): Record<string, SourceNames> {
  const out: Record<string, SourceNames> = {};
  for (const src of sources) {
    const role = src.role;
    const resolved = sourceNamesOf(src);
    const existing = out[role];
    if (existing === undefined) {
      out[role] = resolved;
      continue;
    }
    // The refusal is about DISAGREEMENT, not about the count. An abstract base and the
    // child that extends it may each declare a `@role: primary` source naming the same
    // relation; that is legal and stays legal, because the records then compare equal.
    //
    // Two sources in one role that resolve DIFFERENTLY is the real problem, and silently
    // keeping one is the `dropped` failure mode this artifact makes impossible: the second
    // name is carried nowhere, read by nobody, and the binding quietly takes the first's.
    //
    // WHAT IS COMPARED. The whole resolved record — kind, schema and the physical name
    // under its alias — for EVERY role. `primaryRdbSource` now compares the same address
    // (`sourceAddressKey`) for `primary`, so the two doors agree by construction rather
    // than by coincidence.
    //
    // This comment used to claim the two were "deliberately the SAME rule" when they were
    // not, and the gap was reachable: two `@role: primary` sources agreeing on `@table`
    // but disagreeing on `@schema` loaded clean, were ACCEPTED by `primaryRdbSource` and
    // refused here, so `meta gen` failed on a model every other door admitted. Worse, the
    // weaker key made the accepted answer port-dependent — `primaries[0]` is the inherited
    // source in TS/C#/Python and the own source on the JVM. That is now closed at the
    // authority; this stays because it also covers the non-primary roles (two disagreeing
    // REPLICAs) and because it is what builds the keyed map.
    if (JSON.stringify(existing) !== JSON.stringify(resolved)) {
      throw new Error(
        `${where} declares more than one source.rdb with @role: "${role}", and they ` +
        `disagree on the object's physical address: ${JSON.stringify(existing)} vs ` +
        `${JSON.stringify(resolved)}. The names artifact keys sources by role, so the ` +
        `second has nowhere to go.`,
      );
    }
  }
  return out;
}

/** Every `source.rdb` child of `obj`. `own` restricts to those declared here. */
function rdbSourcesOf(obj: MetaObject, own: boolean): MetaSource[] {
  // ADR-0039: children() resolves through `extends`; ownChildren() is the sanctioned
  // own-only twin for "what does THIS artifact declare".
  const kids = own ? obj.ownChildren() : obj.children();
  return kids.filter((c): c is MetaSource => isMetaSource(c));
}

/** Every `identity.*` / `index.*` child, keyed by metamodel name. */
function keysOf(
  nodes: readonly { readonly name: string; readonly type: string; readonly subType: string }[],
): Record<string, KeyNames> {
  const out: Record<string, KeyNames> = {};
  for (const node of nodes) {
    // resolveIndexName owns BOTH the package strip and the empty-name refusal, so the
    // artifact and the DDL cannot disagree about what an index is called — and an
    // `index.lookup` with an empty name (which the loader accepts, unlike an identity)
    // fails here instead of reaching an emitter.
    const hasIndexName = INDEX_NAMED_SUBTYPES.has(`${node.type}.${node.subType}`);
    out[node.name] = {
      type: node.type,
      subType: node.subType,
      name: node.name,
      ...(hasIndexName ? { index: resolveIndexName(node) } : {}),
    };
  }
  return out;
}

/**
 * The nodes whose database index name the artifact carries.
 *
 * A closed set rather than "anything with a name", because the rule is narrow and worth
 * stating: the artifact carries a physical name only where ONE resolver, shared by codegen
 * and migrate, produces it. `identity.primary` and `identity.reference` have names that are
 * addressing handles, not database names — see {@link KeyNames}.
 */
const INDEX_NAMED_SUBTYPES: ReadonlySet<string> = new Set([
  "identity.secondary",
  "index.lookup",
]);

/**
 * Whether `obj` DECLARES anything a names artifact carries.
 *
 * One predicate, because the artifact has four collections and the two places that ask
 * this question must agree about all four. They used to ask about fields alone, and the
 * cost was precise: an intermediate abstract declaring only an `identity.secondary` — a
 * key hoisted onto a chain, which is the whole reason such a node exists — answered "no".
 * {@link namesArtifactSuperOf} then walked past it and {@link resolveSuperFragmentNames}
 * emitted nothing for it, so its key appeared in NEITHER the child's own set nor the
 * grandparent's spread. `drizzle-schema.ts` still emitted `uniqueIndex(<E>Names.
 * identities.<key>.index)` against it, and the generated code did not compile.
 *
 * ADR-0039's sanctioned own-accessor use: the question is what this node declares, not
 * what it can see. An inherited key belongs to the ancestor that declared it, and is
 * reached through that ancestor's artifact.
 */
function declaresNamesContent(obj: MetaObject): boolean {
  return obj.ownFields().length > 0 ||
    obj.ownIdentities().length > 0 ||
    obj.ownLookupIndexes().length > 0;
}

/**
 * The nearest ancestor of `obj` that carries a names artifact of its own, or undefined.
 *
 * Walks past an ancestor with nothing to contribute — an abstract marker with no fields,
 * no keys and no source emits no artifact, so there is nothing to extend and the search
 * continues upward rather than stopping at a name that does not exist.
 */
export function namesArtifactSuperOf(obj: MetaObject): MetaObject | undefined {
  let cur = obj.superData;
  while (cur !== undefined) {
    // The exported guard, never `as MetaObject` and never a duck-type check on a method
    // name: `superData` is only a MetaData, and CLAUDE.md makes this the required
    // mechanism — two physical copies of the package in one process give a class object
    // and an instance different identities, so `instanceof` returns false for a real node.
    if (isMetaObject(cur) && (declaresNamesContent(cur) || primaryRdbSource(cur) !== undefined)) {
      return cur;
    }
    cur = cur.superData;
  }
  return undefined;
}

export function resolveObjectNames(
  obj: MetaObject,
  strategy?: ColumnNamingStrategy,
): ObjectNames | undefined {
  // #248: an object participates in the database iff it declares (or inherits) a primary
  // source. Never gate on the object subtype. ADR-0039: resolving children().
  //
  // primaryRdbSource, not a scan of our own: it is THE primary-source lookup for the whole
  // toolchain, and it carries the divergence refusal that used to live in this function
  // (see below). A second scan here would be a lookup written twice — the same defect one
  // level down from the one this file exists to prevent (a NAME resolved twice).
  const source = primaryRdbSource(obj);
  if (source === undefined) return undefined;
  const ownFieldList = obj.ownFields();

  const fields: Record<string, FieldNames> = {};
  // ADR-0039: fields() is the RESOLVING accessor — inherited fields must appear, and an
  // inherited @column must resolve, or the constant disagrees with the DDL.
  for (const f of obj.fields()) {
    fields[f.name] = { name: f.name, column: resolveColumnName(f, strategy) };
  }
  // ADR-0039's sanctioned own-accessor use: what this artifact DECLARES. See ObjectNames.
  const ownFields: Record<string, FieldNames> = {};
  for (const f of ownFieldList) {
    ownFields[f.name] = { name: f.name, column: resolveColumnName(f, strategy) };
  }

  const superObj = namesArtifactSuperOf(obj);
  const superNames: SuperNames | undefined = superObj === undefined
    ? undefined
    : { name: superObj.name, package: superObj.package };
  // Identity of the resolved source NODE, not equality of the resolved strings: a
  // divergence guard is exactly what this codebase forbids here, and the question being
  // asked is structural — did this object declare a source, or is it using its parent's?
  const inheritsSource = source !== undefined && superObj !== undefined &&
    primaryRdbSource(superObj) === source;


  // Read the physical name off the primary SOURCE ALREADY IN HAND rather than calling
  // resolveTableName() for it. Both now delegate to primaryRdbSource, so this is no longer
  // about avoiding a second, differently-written lookup — it is that resolveTableName adds
  // a no-source FALLBACK (pluralize(snake(name))) this function must not take: an object
  // with no primary source returns undefined above, and must never acquire a table name it
  // never declared. Mirrors the C# port (CSharpNaming.ResolveObjectNames).
  const name = source.physicalName;

  // The divergence refusal — an object whose @role: primary sources resolve to more than
  // one physical name — used to live HERE, and that was the defect. Every consumer
  // downstream references this name unconditionally (no per-site equality guard; see
  // drizzle-schema.ts), but this function runs only when the `names` generator is in the
  // run, so with namesFile() unwired nothing refused at all: `meta migrate` emitted DDL
  // against the PARENT's table and ObjectManager read and wrote it, silently, on every
  // run. A refusal that depends on which consumer asked is not a refusal.
  //
  // It now lives in primaryRdbSource (@metaobjectsdev/metadata's naming.ts), called
  // above, so resolveTableName, resolveTableSchema, MetaObject.dbTable and this function
  // all inherit it from one implementation. See that function's doc for the reachability
  // analysis — the shape loads with ZERO errors — and for why the check must be
  // DIRECTION-BLIND rather than comparing against the first primary WRITABLE source.
  // names.test.ts pins both directions through this entry point; naming.test.ts (in
  // @metaobjectsdev/metadata) pins the other three doors.

  return {
    type: TYPE_OBJECT,
    subType: obj.subType,
    // The object's OWN name. `source.physicalName` (resolved above as `name`) is now
    // reached through `sources.<role>.<alias>`, which is the point of the restructure:
    // one key stopped meaning a table, a view and a procedure depending on the object.
    name: obj.name,
    sources: sourcesOf(rdbSourcesOf(obj, false), obj.name),
    ownSources: sourcesOf(rdbSourcesOf(obj, true), obj.name),
    fields,
    ownFields,
    identities: keysOf(obj.identities()),
    ownIdentities: keysOf(obj.ownIdentities()),
    indexes: keysOf(obj.lookupIndexes()),
    ownIndexes: keysOf(obj.ownLookupIndexes()),
    superNames,
    inheritsSource,
  };
}

/**
 * The names FRAGMENT for an object that a sourced object extends but which declares no
 * source of its own — the `BaseEntity` pattern: shared fields, no table.
 *
 * Separate from {@link resolveObjectNames} on purpose, and the separation is the #248 rule
 * intact rather than weakened. "Has a primary source" still decides whether an object is a
 * database participant, so an `object.value` carrying fields resolves to nothing here as it
 * always has. A fragment is emitted only for an object REACHED from a participant by
 * walking `extends` upward — which is the only context in which its fields are columns at
 * all. It carries no `kind`/`name`/`readOnly`, because it has no physical name and must
 * never acquire one.
 *
 * Returns undefined when the object declares nothing of its own: an abstract marker has
 * nothing to extend, and emitting an empty artifact for it would put a name in the import
 * graph that says nothing. "Nothing" is {@link declaresNamesContent} — fields OR keys, the
 * same question {@link namesArtifactSuperOf} asks, so the walk and the emit cannot disagree
 * about which ancestors exist.
 */
export function resolveSuperFragmentNames(
  obj: MetaObject,
  strategy?: ColumnNamingStrategy,
): ObjectNames | undefined {
  if (!declaresNamesContent(obj)) return undefined;
  const ownFieldList = obj.ownFields();

  const fields: Record<string, FieldNames> = {};
  for (const f of obj.fields()) {
    fields[f.name] = { name: f.name, column: resolveColumnName(f, strategy) };
  }
  const ownFields: Record<string, FieldNames> = {};
  for (const f of ownFieldList) {
    ownFields[f.name] = { name: f.name, column: resolveColumnName(f, strategy) };
  }
  const superObj = namesArtifactSuperOf(obj);
  return {
    type: TYPE_OBJECT,
    subType: obj.subType,
    name: obj.name,
    // Empty, and emitted as empty rather than omitted: a child spreads `...Super.sources`
    // unconditionally, so the key has to exist. A fragment declares no source and must
    // never acquire a physical name it never wrote.
    sources: {},
    ownSources: {},
    fields,
    ownFields,
    identities: keysOf(obj.identities()),
    ownIdentities: keysOf(obj.ownIdentities()),
    indexes: keysOf(obj.lookupIndexes()),
    ownIndexes: keysOf(obj.ownLookupIndexes()),
    superNames: superObj === undefined
      ? undefined
      : { name: superObj.name, package: superObj.package },
    inheritsSource: false,
  };
}

/**
 * §B2 — the shared builder every `<Object>Names` reference call site used to hand-roll:
 * check whether the artifact exists in this run (`ctx.includeNames`), resolve the
 * constant (`resolveObjectNames`), and build the ts-poet import symbol pointing at
 * `<Object>.names.ts`. Returns undefined whenever the artifact does not exist for this
 * object in this run — a PRESENCE guard ("is the artifact in this run at all"), never the
 * divergence refusal that `primaryRdbSource` owns: this function never compares a
 * resolved value to a literal, it only asks whether the constant exists.
 *
 * `fromPackage` is the package of the FILE BEING EMITTED — the file that will hold the
 * `import { <Object>Names } from …` line — and defaults to `obj.package`, correct for
 * every site that emits `obj`'s OWN module (the entity generator referencing its own
 * names artifact, same object on both ends). A caller emitting a DIFFERENT object's file
 * and reaching across packages for `obj`'s names artifact — an M:N routes file, which
 * lives in the SOURCE entity's package, importing the junction/target's `<X>Names` — MUST
 * pass the emitting file's own package explicitly. Making this an explicit parameter
 * (rather than assuming same-package the way a plain sibling specifier does) is what
 * surfaces that choice: see routes-file.ts's `resolveJunctionColumn`, the one site that
 * got it wrong by assuming same-package.
 */
export function namesRef(
  obj: MetaObject,
  ctx: RenderContext,
  fromPackage: string | undefined = obj.package,
): { readonly resolved: ObjectNames; readonly symbol: Code } | undefined {
  if (!ctx.includeNames) return undefined;
  const resolved = resolveObjectNames(obj, ctx.columnNamingStrategy);
  if (resolved === undefined) return undefined;
  const symbol = code`${imp(
    `${obj.name}Names@${crossEntitySpecifier(
      ctx.selfTarget.outputLayout,
      fromPackage,
      obj.package,
      `${obj.name}.names`,
      ctx.extStyle,
    )}`,
  )}`;
  return { resolved, symbol };
}

/**
 * Adapts a `namesRef()` result to the `{ name, symbol }` shape `renderEntityConstants` /
 * `renderEntityMetaFile` accept. Kept as a separate, narrower shape from `namesRef`'s own
 * `{ resolved, symbol }` rather than folded together: those two functions' parameter
 * predates this helper, and an adopter who already ejected the ADR-0034 reference
 * template calls them with exactly this `{ name, symbol }` shape — widening the required
 * shape to `resolved` would fail to compile in every such copy.
 */
export function namesConstArg(
  names: { readonly resolved: ObjectNames; readonly symbol: Code } | undefined,
  role: string = SOURCE_ROLE_PRIMARY,
): { readonly name: string; readonly symbol: Code } | undefined {
  // `resolved.name` is optional because a FRAGMENT (an abstract base contributing columns,
  // with no source of its own) genuinely has no physical name. No caller reaches here with
  // one — `namesRef` goes through `resolveObjectNames`, which requires a primary source —
  // but returning undefined rather than asserting keeps the fragment case from acquiring a
  // `$table` it never declared, which is the phantom-table failure #248 exists to prevent.
  const src = names?.resolved.sources[role];
  if (names === undefined || src === undefined) return undefined;
  const alias = PHYSICAL_NAME_ATTR_BY_KIND.get(src.kind);
  const physical = alias === undefined ? undefined : src[alias as keyof SourceNames];
  // A fragment (an abstract base contributing columns, no source of its own) genuinely
  // has no physical name. Returning undefined rather than asserting keeps it from
  // acquiring a `$table` it never declared — the phantom-table failure #248 prevents.
  if (typeof physical !== "string") return undefined;
  return { name: physical, symbol: names.symbol };
}

/**
 * A member access that stays valid whatever the key is: `.email` for an identifier,
 * `["2fa-idx"]` otherwise.
 *
 * Needed because two of the artifact's four collections are keyed by an AUTHOR-CHOSEN
 * name. Field keys are field names and are always identifiers; an index name is whatever
 * the author wrote (`uq_cust_email` is an identifier, `2fa-idx` is not), so a dot access
 * built from it does not parse. One helper rather than a per-site guess.
 */
function member(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/**
 * The physical-name expression every §A6 `$table` / view-name site builds: the constant
 * when the artifact is present, the literal otherwise. No equality guard — but the two
 * branches earn that two different ways, and both are worth naming:
 *
 * - A TABLE literal (`drizzle-schema.ts`, `entity-constants.ts`) comes from
 *   `dbTable`/`resolveTableName`, which delegate to `primaryRdbSource` — the same lookup
 *   `resolveObjectNames` uses — so a disagreeing object has already thrown.
 * - A VIEW literal (`projection-decl.ts`, `view-decl.ts`) comes from `viewName()`
 *   (`extract-view-spec.ts`), which reads OWN read-only sources only. That cannot diverge:
 *   a concrete projection may not inherit a source (`ERR_PROJECTION_INHERITED_SOURCE`) and
 *   the loader allows one own primary, so there is nothing for it to disagree with.
 *
 * Either way a reference here is the single spelling, never a lookalike computed twice.
 *
 * `role` selects WHICH source — the parameter that did not exist while the artifact held
 * one name. A write-through entity declares two physical names; passing `replica` is how
 * the read view stops being a literal in TypeScript and C# alike.
 */
export function physicalNameExpr(
  names: { readonly symbol: Code } | undefined,
  literal: string,
  obj: MetaObject,
  role: string = SOURCE_ROLE_PRIMARY,
): Code {
  const alias = sourceAliasOf(obj, role);
  // No alias means either no source in that role or a @kind carrying no physical-name
  // slot. Falling back to the literal keeps a future @kind from emitting `undefined` into
  // a table binding, which would fail at the database rather than at the compiler.
  if (names === undefined || alias === undefined) return code`${JSON.stringify(literal)}`;
  return code`${names.symbol}.sources${member(role)}.${alias}`;
}

/**
 * The physical-name alias key for `obj`'s source in `role` — `table`, `view`, `proc`, …
 *
 * Derived from the object rather than taken as a parameter, so a call site cannot pass an
 * alias that disagrees with the source it is describing. Reads the metamodel's own
 * `PHYSICAL_NAME_ATTR_BY_KIND`; a local switch here would be a second answer to a
 * question the metamodel already answers, which is the defect class this file exists for.
 */
export function sourceAliasOf(obj: MetaObject, role: string = SOURCE_ROLE_PRIMARY): string | undefined {
  const src = rdbSourcesOf(obj, false).find((c) => c.role === role);
  return src === undefined ? undefined : PHYSICAL_NAME_ATTR_BY_KIND.get(src.effectiveKind);
}

/**
 * A source's `@schema` expression, or undefined when the source declares none.
 *
 * Undefined rather than a literal fallback: an absent `@schema` means "the dialect's
 * default", which a caller expresses by omitting the qualifier entirely — emitting `""`
 * or `"public"` would be this artifact inventing a name the author never wrote.
 */
export function sourceSchemaExpr(
  names: { readonly resolved: ObjectNames; readonly symbol: Code } | undefined,
  role: string = SOURCE_ROLE_PRIMARY,
): Code | undefined {
  const src = names?.resolved.sources[role];
  if (names === undefined || src === undefined || src.schema === undefined) return undefined;
  return code`${names.symbol}.sources${member(role)}.schema`;
}

/**
 * An index's database-name expression — the constant when the artifact carries the node,
 * the literal otherwise.
 *
 * The literal arm goes through `resolveIndexName` rather than reading `node.name`, so the
 * names-off path and the names-on path answer with the same function. That is the whole
 * lesson of `fdb4118f1`: two spellings of one name agree until they do not.
 */
export function indexNameExpr(
  names: { readonly resolved: ObjectNames; readonly symbol: Code } | undefined,
  node: { readonly name: string; readonly type: string; readonly subType: string },
): Code {
  const collection = node.type === TYPE_INDEX ? "indexes" : "identities";
  const entry = names?.resolved[collection][node.name];
  return names !== undefined && entry !== undefined && entry.index !== undefined
    ? code`${names.symbol}.${collection}${member(node.name)}.index`
    : code`${JSON.stringify(resolveIndexName(node))}`;
}

/**
 * A field's physical-column expression: the constant when the given artifact carries the
 * field, the literal otherwise.
 *
 * The literal arm is a PRESENCE guard — "no artifact in this run", the documented ADR-0034
 * opt-out — and NOT a divergence guard. It used to carry a second sanctioned case: a TPH
 * fold emitting a subtype's own columns, which the BASE's artifact never saw. That was
 * never a presence question; the constant existed the whole time, in the subtype's own
 * artifact. Callers now resolve the declaring entity's ref before falling back
 * (`drizzle-schema.ts`), so a miss no longer has a known-good explanation and the fallback
 * is the last resort it was meant to be.
 */
export function columnExpr(
  names: { readonly resolved: ObjectNames; readonly symbol: Code } | undefined,
  fieldName: string,
  literal: string,
): Code {
  const entry = names?.resolved.fields[fieldName];
  return names !== undefined && entry !== undefined
    ? code`${names.symbol}.fields.${fieldName}.column`
    : code`${JSON.stringify(literal)}`;
}
