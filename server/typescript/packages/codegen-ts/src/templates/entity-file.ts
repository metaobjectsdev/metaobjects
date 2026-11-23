// Entity file composer — writes one <Entity>.ts: the Drizzle table, inferred types, Zod
// validators, constants, filter allowlists and filter type, with the @generated header.
// It is a class on the TypeScript writer with one overridable method per section
// (spec/code-writer.md, "Extension by subclassing"): an adopter subclasses it, overrides the
// section it wants changed, and passes the subclass as the entity generator's `writer`.
//
// Dispatch (`compose`):
//   isAbstract(entity)                 → writeShape (interface + Zod, never a table)
//   isProjection(entity)               → writeProjection (view declaration + Zod + filter sections)
//   !hasWritableRdbSource(entity)      → writeShape (in-memory / transit shape: interface + Zod schema)
//   vanilla / write-through entity     → writeTableModule (the Drizzle table path)

import { CodegenError } from "../errors.js";
import { flattenedMembersOf } from "../flattened.js";
import type { MetaObject, MetaField } from "@metaobjectsdev/metadata";
import { SOURCE_ROLE_REPLICA } from "@metaobjectsdev/metadata";
import type { RenderContext } from "../render-context.js";
import { writeDrizzleSchema } from "./drizzle-schema.js";
import { writeInferredTypes, writeEnumTypeAliases } from "./inferred-types.js";
import { writeZodValidators, primaryIdentityFieldNames } from "./zod-validators.js";
import { isTphSubtype } from "../tph.js";
import { writeEntityConstants } from "./entity-constants.js";
import { writeFilterAllowlist, writeSortAllowlist } from "./filter-allowlist.js";
import { writeFilterType } from "./filter-type.js";
import { writeTphDiscriminatorUnion, isTphDiscriminatorBase, hasTphDiscriminatorUnion } from "./tph-discriminator.js";
import { GENERATED_HEADER, GENERATED_EDIT_NOTE, sidecarComment } from "../constants.js";
import { isProjection, isWriteThrough } from "../projection/projection-detector.js";
import { writeProjectionDecl } from "./projection-decl.js";
import {
  projectionViewName, projectionViewSchema, projectionViewRole,
} from "../projection/extract-view-spec.js";
import { writeExistingViewDecl, writeViewReadZodObject, type ViewDeclOpts } from "./view-decl.js";
import { writeDocsFor } from "./jsdoc.js";
import { valueObjectFieldImport } from "../import-path.js";
import { namesRef, namesConstArg, physicalNameExpr, sourceSchemaExpr } from "../names.js";
import { hasWritableRdbSource } from "../source-detect.js";
import { writeValueObjectFile } from "./value-object-file.js";
import { isAbstract } from "../instance-artifacts.js";
import { effectivePackage } from "../docs-paths.js";
import { TsWriter } from "../writer/ts-writer.js";

/**
 * Render-time options for the entity-file composer.
 *
 * `allowlists` (default `true`) controls whether the Fastify-flavored
 * `<Entity>FilterAllowlist` + `<Entity>SortAllowlist` blocks (plus their
 * `runtime-ts/drizzle-fastify` type-only imports) are emitted. Workers/Lambda
 * consumers that don't mount Fastify-style server routes can pass `false` and
 * drop `@metaobjectsdev/runtime-ts` from their deps entirely. The client-side
 * `<Entity>Filter` type is always emitted — consumers still want it for typed
 * client calls regardless of how the server is wired.
 *
 * Whether the file emits ANY server runtime binding at all (Drizzle table/view,
 * the allowlists) is governed by the TARGET, not this option: `ctx.selfTarget.runtime`.
 * A contract-only target (`runtime: false`) renders every object as its plain
 * shape (interface + Zod) and every projection as its read schema — no
 * `drizzle-orm`, no `runtime-ts`. `allowlists` is a finer Fastify-vs-Hono opt-out
 * that only matters within a runtime target.
 */
export interface RenderEntityFileOpts {
  readonly allowlists?: boolean;
}

export function renderEntityFile(
  entity: MetaObject,
  ctx: RenderContext,
  opts?: RenderEntityFileOpts,
): string {
  return new EntityFileWriter(entity, ctx, opts).compose().toString();
}

/** An {@link EntityFileWriter} subclass, as the entity generator's `writer` option takes it. */
export type EntityFileWriterClass = new (entity: MetaObject, ctx: RenderContext, opts?: RenderEntityFileOpts) => EntityFileWriter;

/**
 * Writes one entity module. `compose()` picks the module's shape and calls one method per
 * section; override a method to change that section, and pass the subclass as `writer`.
 * The methods are not a stability contract (spec/code-writer.md).
 */
export class EntityFileWriter extends TsWriter {
  /** Whether this target binds a server runtime at all (`ctx.selfTarget.runtime`). */
  protected readonly runtime: boolean;
  /** Whether the Fastify-flavored filter and sort allowlists are written. */
  protected readonly allowlists: boolean;

  constructor(
    protected readonly entity: MetaObject,
    protected readonly ctx: RenderContext,
    opts?: RenderEntityFileOpts,
  ) {
    super();
    // Contract-only target ⇒ no server runtime: no Drizzle pgView/pgTable, no
    // runtime-ts allowlists. The read schema + inferred types still emit.
    this.runtime = ctx.selfTarget.runtime;
    this.allowlists = this.runtime ? (opts?.allowlists ?? true) : false;
  }

  /** Write the whole module into this writer; returns it, for `toString()`. */
  compose(): this {
    const { entity } = this;
    // --- Abstract path (shape only) ---
    // An abstract entity contributes shape via inheritance only — it must NEVER
    // produce a Drizzle table / migration footprint / filter allowlist, even when
    // it carries a source.rdb child. This is the cross-port invariant (abstract →
    // no instance/write artifacts, including CREATE TABLE). It still emits its
    // value-object shape (interface + Zod) so subclasses/consumers can reference
    // it. The entity-file generator suppresses this entirely when
    // emitAbstractShapes is off; here we only guarantee "shape, never table".
    if (isAbstract(entity)) this.writeShape();
    // --- Projection path (read-only: view-backed entity with no table source) ---
    // Projections intentionally get the z.enum() validator but NOT a named enum
    // type alias — emitting aliases here is a deliberate v1 scope decision.
    else if (isProjection(entity)) this.writeProjection();
    // --- Value-only / contract path (no Drizzle table) ---
    // Reached when the entity has no writable source.rdb (in-memory / transit
    // shape) OR the target is contract-only (a UI/wire package gets the read shape,
    // not a DB table). Either way: interface + Zod, no migration footprint, no
    // drizzle-orm. Consumers validate via the Zod schema and type via the interface.
    //
    // A TPH subtype (FR-017) also routes here: it inherits the base's writable
    // source.rdb via extends (so hasWritableRdbSource is now true under the ADR-0039
    // resolving read), but the base owns the single shared table — the subtype must
    // emit its per-subtype read schema (<Sub>Schema), never its own pgTable.
    else if (!this.runtime || !hasWritableRdbSource(entity) || isTphSubtype(entity)) this.writeShape();
    // --- Vanilla / write-through entity path ---
    else this.writeTableModule();
    return this;
  }

  /** The value-only module: interface + Zod schema (value-object-file.ts). */
  protected writeShape(): void {
    writeValueObjectFile(this, this.entity, this.ctx);
  }

  /** The projection's read model: view declaration, read schema, constants, filters (projection-decl.ts). */
  protected writeProjection(): void {
    const { entity, ctx } = this;
    // §A6/§B2 — same `namesRef` pair drizzle-schema.ts builds, so the projection's view
    // name + per-field dbCol reference the exact constant the names artifact exports
    // (undefined when the artifact is not in this run — see names.ts). `namesRef`'s
    // `{ resolved, symbol }` return is exactly the shape `ProjectionDeclOpts.names` wants.
    writeProjectionDecl(this, entity, ctx.loadedRoot, {
      columnNamingStrategy: ctx.columnNamingStrategy,
      dialect: ctx.dialect,
      apiPrefix: ctx.apiPrefix,
      timestampMode: ctx.timestampMode,
      allowlists: this.allowlists,
      ctx,
      // Contract target drops the Drizzle .existing() view decl + drizzle-orm import.
      includeViewDecl: this.runtime,
      names: namesRef(entity, ctx),
    });
  }

  /** A table-backed entity: every section, in file order. */
  protected writeTableModule(): void {
    const { entity, ctx } = this;
    // FR-017: when a discriminator base also has a union block, the union owns the
    // bare `<Base>` type — so the inferred Drizzle row type is emitted as
    // `<Base>Row` to avoid a duplicate `export type <Base>`.
    const tphBase = hasTphDiscriminatorUnion(entity, ctx.loadedRoot) && isTphDiscriminatorBase(entity, ctx.loadedRoot);

    // #214 — a write-through entity read-view (FR-024 §7): reads route to the replica
    // VIEW, so the entity file additionally declares the `.existing()` view (carrying the
    // derived fields the write table omits, #213) and a read schema `<Entity>Schema`
    // whose `z.infer` IS the read type <Entity> (dialect-agnostic — a Drizzle view is not
    // a Table, so InferSelectModel/`$inferSelect` don't uniformly apply; the Zod schema's
    // nullability mirrors the view columns exactly like a projection). The write table +
    // Insert/Update stay derived-free. `.existing()` is a runtime-target Drizzle binding,
    // and this path only runs in a runtime target (contract-only/non-writable returned above).
    // A TPH discriminator base owns `export type <Base>` via its discriminated-union block,
    // so it must NOT also emit the view-schema read type (that would be a duplicate-identifier
    // compile error). A base+write-through combo keeps the TPH polymorphic read path (reads
    // the base table); routing its reads through a replica view is a documented non-goal.
    const writeThrough = isWriteThrough(entity) && !tphBase;
    // A write-through entity reads through a replica view whose columns are declared per field;
    // that declaration has no flattened-member form yet, and a view column bound under the wrong
    // name fails at query time, so refuse rather than emit it.
    if (writeThrough && entity.fields().some((f) => flattenedMembersOf(f, ctx.columnNamingStrategy) !== undefined)) {
      throw new CodegenError(
        `${entity.name}: a write-through entity (writable table plus a replica view) cannot hold a ` +
          `field.object @storage: flattened field yet - the replica view declaration has no flattened-member form. ` +
          `Use @storage: jsonb, or drop the replica view.`,
      );
    }

    this.writeFileHeader();
    // Written BEFORE the replica view, for two reasons that both matter: the table
    // DECLARES the int-backed-enum codecs (a `const` the view's declaration would duplicate,
    // and a duplicate module-scope const is a parse error), and those consts must precede the
    // view's use of them in the emitted file or the view hits a TDZ ReferenceError at import.
    const declaredEnumIntCodecs = new Set<string>();
    this.writeTable(declaredEnumIntCodecs);
    if (writeThrough) this.writeReplicaView(declaredEnumIntCodecs);
    this.writeRowTypes(tphBase, writeThrough /* skipRow — read type is the view schema */);
    this.writeEnumAliases();
    this.writeValidators();
    this.writeConstants();
    if (this.allowlists) this.writeAllowlists();
    this.writeFilter();
    this.writeTphUnion();
  }

  /** The `@generated` banner, the source line and the sidecar hint. */
  protected writeFileHeader(): void {
    const { entity } = this;
    this.header(
      `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`,
      `// Source metadata: ${entity.name} (${entity.fqn()})`,
      sidecarComment(`${entity.name}.extra.ts`),
    );
  }

  /** The Drizzle table, the codecs it declares and its `relations()` block (drizzle-schema.ts). */
  protected writeTable(declaredEnumIntCodecs: Set<string>): void {
    writeDrizzleSchema(this, this.entity, this.ctx, declaredEnumIntCodecs);
  }

  /** A write-through entity's replica view, its read schema and its read type. */
  protected writeReplicaView(declaredEnumIntCodecs: ReadonlySet<string>): void {
    const { entity, ctx } = this;
    const camel = entity.name.charAt(0).toLowerCase() + entity.name.slice(1);
    const fields = entity.fields();
    const entityPkg = effectivePackage(entity);
    // ONE selection of the replica source: `projectionViewName` names it, and this is the
    // role its entry has in <Entity>Names.sources. Hardcoding "replica" here would be a
    // second derivation of the very thing extract-view-spec.ts exists to decide once.
    const viewRole = projectionViewRole(entity) ?? SOURCE_ROLE_REPLICA;
    const entityNames = namesRef(entity, ctx);
    const viewOpts: ViewDeclOpts = {
      dialect: ctx.dialect, columnNamingStrategy: ctx.columnNamingStrategy, timestampMode: ctx.timestampMode,
      // A view column's `@objectRef`: the bound value object's import under its local name,
      // through the same helper the entity's own columns use.
      voRef: (field: MetaField, suffix: string, typeOnly: boolean) =>
        valueObjectFieldImport(ctx, field, entityPkg, suffix, typeOnly),
      // PK fields type non-null in the replica-view decl + read schema even
      // without @required (a PK is never NULL; see ViewDeclOpts.pkFieldNames).
      pkFieldNames: new Set(primaryIdentityFieldNames(entity)),
      // §A6 — the entity's names artifact supplies this view's COLUMN constants. A
      // replica view exposes the entity's own fields, so `<Entity>Names.fields.<f>.column`
      // is the same physical name the table side binds; a derived field the artifact
      // does not carry falls back to the literal via `columnExpr`. The view's own NAME
      // is passed separately below and stays a literal — the artifact holds the primary
      // (table) source's name, not this one.
      names: entityNames,
      // The table above already declared these; the view references them by name.
      declaredEnumIntCodecs: new Set(declaredEnumIntCodecs),
      // The replica view's OWN @schema, from the same source node projectionViewName picks
      // — never the entity's, which is the WRITE TABLE's and would qualify this view with a
      // schema that belongs to something else. A view and the table it replicates need not
      // live in the same schema, and a name paired with someone else's schema is worse than
      // no schema at all.
      //
      // Both this and the view's NAME are now CONSTANTS. They were literals for a real
      // reason that has stopped being true: <Entity>Names carried the primary source only,
      // so a write-through entity's two physical names had one slot between them and the
      // second was emitted in full — the same escape C#'s AppDbContext had, in a different
      // language, which is what showed it was the artifact's shape and not the binding.
      schema: sourceSchemaExpr(entityNames, viewRole) ?? projectionViewSchema(entity),
    };
    writeExistingViewDecl(
      this,
      fields,
      physicalNameExpr(entityNames, projectionViewName(entity, ctx.columnNamingStrategy), entity, viewRole),
      `${camel}View`,
      viewOpts,
    );
    this.blank();
    writeViewReadZodObject(this, fields, viewOpts, `export const ${entity.name}Schema = `, ";");
    this.blank();
    writeDocsFor(this, entity);
    this.line(`export type ${entity.name} = ${this.use("z", "zod")}.infer<typeof ${entity.name}Schema>;`);
  }

  /** The row, insert and update types inferred from the table (inferred-types.ts). */
  protected writeRowTypes(tphBase: boolean, skipRow: boolean): void {
    writeInferredTypes(this, this.entity, tphBase, this.ctx, skipRow);
  }

  /** A named type alias per enum field (nothing when the entity has none). */
  protected writeEnumAliases(): void {
    writeEnumTypeAliases(this, this.entity, this.ctx);
  }

  /** The Zod insert and update schemas (zod-validators.ts). */
  protected writeValidators(): void {
    writeZodValidators(this.blank(), this.entity, this.ctx);
  }

  /** The `<Entity>` constants object: table, path and field descriptors (entity-constants.ts). */
  protected writeConstants(): void {
    // §A6/§B2 — same `namesRef` pair drizzle-schema.ts (and the projection path) build,
    // so the descriptor's $table references the exact constant the names artifact exports
    // (undefined when the artifact is not in this run).
    writeEntityConstants(this, this.entity, namesConstArg(namesRef(this.entity, this.ctx)));
  }

  /** The server-side filter and sort allowlists (filter-allowlist.ts). */
  protected writeAllowlists(): void {
    writeFilterAllowlist(this, this.entity, undefined, this.ctx);
    writeSortAllowlist(this, this.entity, undefined, this.ctx);
  }

  /** The client `<Entity>Filter` type (filter-type.ts). */
  protected writeFilter(): void {
    writeFilterType(this, this.entity, undefined, this.ctx.loadedRoot);
  }

  /**
   * FR-017 Tier 1: on a discriminator base with concrete subtypes, the discriminated-union
   * type, its guards and the parse<Base>(row) dispatcher; nothing otherwise.
   */
  protected writeTphUnion(): void {
    writeTphDiscriminatorUnion(this, this.entity, this.ctx.loadedRoot);
  }
}
