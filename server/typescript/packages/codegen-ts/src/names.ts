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
  resolveTableSchema,
  type ColumnNamingStrategy,
  type MetaObject,
} from "@metaobjectsdev/metadata";
import { code, imp, type Code } from "ts-poet";
import { crossEntitySpecifier } from "./import-path.js";
import type { RenderContext } from "./render-context.js";

export interface FieldNames { readonly name: string; readonly column: string; }

/** The object whose names artifact this one extends. */
export interface SuperNames {
  readonly name: string;
  readonly package?: string | undefined;
}

export interface ObjectNames {
  /**
   * The `source.rdb @kind` value — `table` | `view` | `materializedView` | …
   * Absent on a FRAGMENT: an abstract base with no source of its own, which contributes
   * columns to its children and has no physical name of its own to carry.
   */
  readonly kind?: string | undefined;
  /** The PHYSICAL name. Not necessarily a table: resolveTableName delegates to
   *  source.physicalName for every @kind, so this can be a view or a proc.
   *  Absent on a fragment — see `kind`. */
  readonly name?: string | undefined;
  readonly schema?: string | undefined;
  /** Absent on a fragment — see `kind`. */
  readonly readOnly?: boolean | undefined;
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
  /** The nearest ancestor carrying an artifact of its own, when there is one. */
  readonly superNames?: SuperNames | undefined;
  /**
   * True when the primary source is the SUPER's rather than declared here — a TPH
   * subtype, which shares its base's single table. Structural (the two resolve to the
   * SAME source node), never an equality test on the resolved strings: the physical
   * name, kind, schema and read-only-ness then all come from the super's artifact rather
   * than being restated.
   */
  readonly inheritsSource: boolean;
}

/**
 * The nearest ancestor of `obj` that carries a names artifact of its own, or undefined.
 *
 * Walks past an ancestor with nothing to contribute — an abstract marker with no fields
 * and no source emits no artifact, so there is nothing to extend and the search continues
 * upward rather than stopping at a name that does not exist.
 */
export function namesArtifactSuperOf(obj: MetaObject): MetaObject | undefined {
  let cur = obj.superData;
  while (cur !== undefined) {
    const candidate = cur as MetaObject;
    if (typeof candidate.ownFields === "function" &&
        (candidate.ownFields().length > 0 || primaryRdbSource(candidate) !== undefined)) {
      return candidate;
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

  const schema = resolveTableSchema(obj);
  return {
    // `effectiveKind`, NOT a `kind` property — MetaSource exposes the @kind value through
    // that accessor, defaulting to "table" per ADR-0007 Rule 3, and resolving it through
    // `extends` so an inherited source's @kind is seen.
    kind: source.effectiveKind,
    name,
    ...(schema === undefined ? {} : { schema }),
    // Derived from the source's OWN logic, never a hand-rolled kind list here — a second
    // list would drift from the loader's the first time a read-only kind is added.
    readOnly: source.isReadOnly(),
    fields,
    ownFields,
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
 * Returns undefined when the object declares no fields of its own: an abstract marker has
 * nothing to extend, and emitting an empty artifact for it would put a name in the import
 * graph that says nothing.
 */
export function resolveSuperFragmentNames(
  obj: MetaObject,
  strategy?: ColumnNamingStrategy,
): ObjectNames | undefined {
  const ownFieldList = obj.ownFields();
  if (ownFieldList.length === 0) return undefined;

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
    fields,
    ownFields,
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
): { readonly name: string; readonly symbol: Code } | undefined {
  // `resolved.name` is optional because a FRAGMENT (an abstract base contributing columns,
  // with no source of its own) genuinely has no physical name. No caller reaches here with
  // one — `namesRef` goes through `resolveObjectNames`, which requires a primary source —
  // but returning undefined rather than asserting keeps the fragment case from acquiring a
  // `$table` it never declared, which is the phantom-table failure #248 exists to prevent.
  if (names === undefined || names.resolved.name === undefined) return undefined;
  return { name: names.resolved.name, symbol: names.symbol };
}

/**
 * The physical-name expression every §A6 `$table` / view-name site builds: the constant's
 * `.name` when the artifact is present, the literal otherwise. No equality guard — but the
 * two branches earn that two different ways, and both are worth naming:
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
 */
export function physicalNameExpr(
  names: { readonly symbol: Code } | undefined,
  literal: string,
): Code {
  return names !== undefined ? code`${names.symbol}.name` : code`${JSON.stringify(literal)}`;
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
