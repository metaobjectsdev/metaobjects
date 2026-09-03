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

export interface ObjectNames {
  /** The `source.rdb @kind` value — `table` | `view` | `materializedView` | … */
  readonly kind: string;
  /** The PHYSICAL name. Not necessarily a table: resolveTableName delegates to
   *  source.physicalName for every @kind, so this can be a view or a proc. */
  readonly name: string;
  readonly schema?: string;
  readonly readOnly: boolean;
  readonly fields: Readonly<Record<string, FieldNames>>;
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

  const fields: Record<string, FieldNames> = {};
  // ADR-0039: fields() is the RESOLVING accessor — inherited fields must appear, and an
  // inherited @column must resolve, or the constant disagrees with the DDL.
  for (const f of obj.fields()) {
    fields[f.name] = { name: f.name, column: resolveColumnName(f, strategy) };
  }

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
  return names === undefined ? undefined : { name: names.resolved.name, symbol: names.symbol };
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
 * A field's physical-column expression. A lookup MISS — the artifact is present but does
 * not carry this field (e.g. a TPH fold emitting columns for a subtype's own fields,
 * which the base's names artifact never saw) — is a PRESENCE guard, not the forbidden
 * divergence guard: it falls back to the literal, exactly as when the artifact isn't in
 * the run at all.
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
