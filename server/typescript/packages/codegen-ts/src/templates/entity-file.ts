// Entity file composer — combines drizzle-schema, inferred-types, and zod-validators
// into one file with the @generated header. ts-poet deduplicates imports.
//
// Dispatch:
//   isProjection(entity)               → renderProjectionDecl (read-only: view declaration + Zod + filter sections)
//   !hasWritableRdbSource(entity)      → renderValueObjectFile (in-memory / transit shape: interface + Zod schema)
//   vanilla / write-through entity     → Drizzle table path

import { joinCode, type Code } from "ts-poet";
import type { MetaObject } from "@metaobjectsdev/metadata";
import type { RenderContext } from "../render-context.js";
import { renderDrizzleSchema } from "./drizzle-schema.js";
import { renderInferredTypes, renderEnumTypeAliases } from "./inferred-types.js";
import { renderZodValidators } from "./zod-validators.js";
import { renderEntityConstants } from "./entity-constants.js";
import { renderFilterAllowlist, renderSortAllowlist } from "./filter-allowlist.js";
import { renderFilterType } from "./filter-type.js";
import { renderTphDiscriminatorUnion, isTphDiscriminatorBase } from "./tph-discriminator.js";
import { GENERATED_HEADER } from "../constants.js";
import { isProjection } from "../projection/projection-detector.js";
import { renderProjectionDecl } from "./projection-decl.js";
import { hasWritableRdbSource } from "../source-detect.js";
import { renderValueObjectFile } from "./value-object-file.js";
import { isAbstract } from "../instance-artifacts.js";

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
  // Contract-only target ⇒ no server runtime: no Drizzle pgView/pgTable, no
  // runtime-ts allowlists. The read schema + inferred types still emit.
  const runtime = ctx.selfTarget.runtime;
  const allowlists = runtime ? (opts?.allowlists ?? true) : false;

  // --- Abstract path (shape only) ---
  // An abstract entity contributes shape via inheritance only — it must NEVER
  // produce a Drizzle table / migration footprint / filter allowlist, even when
  // it carries a source.rdb child. This is the cross-port invariant (abstract →
  // no instance/write artifacts, including CREATE TABLE). It still emits its
  // value-object shape (interface + Zod) so subclasses/consumers can reference
  // it. The entity-file generator suppresses this entirely when
  // emitAbstractShapes is off; here we only guarantee "shape, never table".
  if (isAbstract(entity)) {
    return renderValueObjectFile(entity, ctx.apiPrefix, ctx);
  }

  // --- Projection path (read-only: view-backed entity with no table source) ---
  // Projections intentionally get the z.enum() validator but NOT a named enum
  // type alias — emitting aliases here is a deliberate v1 scope decision.
  if (isProjection(entity)) {
    return renderProjectionDecl(entity, ctx.loadedRoot, {
      columnNamingStrategy: ctx.columnNamingStrategy,
      dialect: ctx.dialect,
      apiPrefix: ctx.apiPrefix,
      timestampMode: ctx.timestampMode,
      allowlists,
      ctx,
      // Contract target drops the Drizzle .existing() view decl + drizzle-orm import.
      includeViewDecl: runtime,
    });
  }

  // --- Value-only / contract path (no Drizzle table) ---
  // Reached when the entity has no writable source.rdb (in-memory / transit
  // shape) OR the target is contract-only (a UI/wire package gets the read shape,
  // not a DB table). Either way: interface + Zod, no migration footprint, no
  // drizzle-orm. Consumers validate via the Zod schema and type via the interface.
  if (!runtime || !hasWritableRdbSource(entity)) {
    return renderValueObjectFile(entity, ctx.apiPrefix, ctx);
  }

  // --- Vanilla / write-through entity path ---
  const enumAliases = renderEnumTypeAliases(entity, ctx);
  // FR-017 Tier 1: when this entity carries @discriminator AND has concrete
  // subtypes, append the discriminated-union type alias, type guards, and
  // the parse<Base>(row) dispatcher. Returns null otherwise (no subtypes, or
  // not a discriminator-bearing entity); the section is suppressed cleanly.
  const tphBlock = renderTphDiscriminatorUnion(entity, ctx.loadedRoot);
  // FR-017: when a discriminator base also has a union block, the union owns the
  // bare `<Base>` type — so the inferred Drizzle row type is emitted as
  // `<Base>Row` to avoid a duplicate `export type <Base>`.
  const tphBase = tphBlock !== null && isTphDiscriminatorBase(entity, ctx.loadedRoot);
  const sections: Code[] = [
    renderDrizzleSchema(entity, ctx),
    renderInferredTypes(entity, tphBase, ctx),
    ...(enumAliases !== null ? [enumAliases] : []),
    renderZodValidators(entity, ctx),
    renderEntityConstants(entity, ctx.apiPrefix),
    ...(allowlists ? [renderFilterAllowlist(entity), renderSortAllowlist(entity)] : []),
    renderFilterType(entity),
    ...(tphBlock !== null ? [tphBlock] : []),
  ];

  // Render ts-poet body first (ts-poet hoists imp()-tracked imports to the top),
  // then prepend the @generated header so it lands at line 1 — convention for
  // generated files and what most tooling (overwrite-policy, IDEs) expects.
  const body = joinCode(sections, { on: "\n" }).toString();
  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${entity.name} (${entity.fqn()})\n` +
    `// Customize via ${entity.name}.extra.ts in this directory.\n`;
  return header + body;
}
