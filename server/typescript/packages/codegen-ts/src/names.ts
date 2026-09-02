/**
 * §A2/§A3 — the ONE place a data name is resolved for a generator run.
 *
 * Both the names artifact (namesFile) and the entity generator that consumes it call this,
 * so the constant and the binding it describes cannot be produced by different resolvers or
 * different arguments. That is the whole rule; a name computed twice is a name that can
 * disagree with itself.
 */
import {
  isMetaSource,
  resolveColumnName,
  resolveTableName,
  resolveTableSchema,
  type ColumnNamingStrategy,
  type MetaObject,
  type MetaSource,
  SOURCE_ROLE_PRIMARY,
} from "@metaobjectsdev/metadata";
import { code, imp, type Code } from "ts-poet";
import { CodegenError } from "./errors.js";
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
  // isMetaSource, not `instanceof` — two physical copies of @metaobjectsdev/metadata in
  // one process give the class and the instance different identities, and the failure is
  // SILENT: the entity reads as "not backed by any store" and emits nothing.
  const source = obj.children().find(
    (c): c is MetaSource => isMetaSource(c) && c.role === SOURCE_ROLE_PRIMARY,
  );
  if (source === undefined) return undefined;

  const fields: Record<string, FieldNames> = {};
  // ADR-0039: fields() is the RESOLVING accessor — inherited fields must appear, and an
  // inherited @column must resolve, or the constant disagrees with the DDL.
  for (const f of obj.fields()) {
    fields[f.name] = { name: f.name, column: resolveColumnName(f, strategy) };
  }

  const name = resolveTableName(obj);
  // Every consumer downstream references this name unconditionally (no per-site equality
  // guard — see drizzle-schema.ts). Refuse here instead, once, so nothing downstream has to.
  //
  // This CAN fire on real metadata: validateSourceRoles (metadata/src/persistence/source/
  // validate-source-roles.ts) enforces "exactly one primary" over ownChildren() only, never
  // over the effective inherited set, and _effectiveChildren (metadata/src/shared/
  // meta-data.ts) shadows an own child over a super child only on a (type, name) match. Two
  // source.rdb children with DIFFERENT explicit names never collide, so extending an
  // abstract object whose own primary source is read-only with a child that adds its own,
  // differently-named, writable primary source leaves BOTH on the effective children() list
  // rather than one shadowing the other. resolveTableName's looser `find(role==="primary")`
  // then returns the first (inherited, read-only) one; `dbTable`'s stricter
  // `find(role==="primary" && isWritable())` skips it and matches the later, writable one —
  // two real, different, defined strings.
  const writable = obj.dbTable;
  if (writable !== undefined && writable !== name) {
    throw new CodegenError(
      `${obj.name}: primary source resolves to "${name}" but the primary WRITABLE source ` +
      `resolves to "${writable}". A read-only primary beside a writable replica has no single ` +
      `physical name to bind; give the object one writable primary source.`,
    );
  }

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
 * divergence guard `resolveObjectNames` already owns above: this function never compares
 * a resolved value to a literal, it only asks whether the constant exists.
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
 * `.name` when the artifact is present, the literal otherwise. No equality guard —
 * `resolveObjectNames` already refuses (throws) any object whose two resolvers disagree,
 * so a reference here is the single spelling, never a lookalike computed twice.
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
