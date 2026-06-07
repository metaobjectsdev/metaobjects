// server/typescript/packages/codegen-ts/src/generators/api-model.ts
//
// ApiModel — an intermediate representation (IR) of the PUBLIC API surface an
// adopter's codegen produces from their metadata. The whole point is to be
// ACCURATE BY CONSTRUCTION: every symbol NAME here is derived by REUSING the
// real generators' own naming/signature logic (the same helpers the generators
// call when they emit code), never invented. The Task-4 accuracy gate runs the
// real generators and asserts each ApiModel symbol name actually appears in the
// generated output — so this builder must agree with them by construction.
//
// What it documents, per node:
//   • ENTITY (object.entity, queryable):
//       - model        : the entity type/const (entity-file emits `<Name>`)
//       - data-access  : findById / list / create / update / deleteById helpers
//                        (templates/queries.ts — exact spellings via naming.ts)
//       - rest         : the 5 CRUD endpoints the routes generator mounts at the
//                        entity's $path (read-only set for projections)
//       - validation   : <Name>InsertSchema / <Name>UpdateSchema (zod-validators)
//   • template.output:
//       - extractor    : extract<Name> / extractLenient<Name> (templates/extractor.ts)
//                        — ONLY when @format is json/xml (extractor generator gate)
//       - render       : render<Name> (templates/render-helper.ts) — document →
//                        string, email → EmailDocument (@kind gate)
//   • ENTITY (additional, T5 — relationships / callable / Hono):
//       - relation     : the `<var>Relations` drizzle relations() export the
//                        entity file composes (relations-block.ts), one per entity
//                        that has relations; the per-navigation accessors (1:N
//                        one() / M:N many(junction)) ride in its field shape, named
//                        + cardinality-tagged + target-tagged. ONLY when the
//                        relation-resolver derives a relations() block for it.
//       - callable     : call<Entity> (templates/callable-file.ts) — ONLY when the
//                        entity is backed by a stored-proc / table-function source
//                        (isCallableEntity); the typed proc wrapper.
//       - rest-hono    : the Hono CRUD registrar register<Entity>Routes
//                        (templates/routes-file-hono.ts) — the OPT-IN Hono variant
//                        of the Fastify REST surface. Documented ONLY when the
//                        adopter wires routesFileHono() (ctx.includeHonoRoutes), and
//                        gated by the SAME @emitRoutes:false filter.
//   • template.prompt (T5):
//       - prompt       : render<Name> (payload, provider): string — the prompt
//                        render handle promptRender() emits into a single
//                        aggregated `prompts.ts` (payload-codegen generateRenderHandle).
//                        ONLY for TOP-LEVEL template.prompt nodes (matching
//                        prompt-render-file.ts's `ctx.loadedRoot.ownChildren()`).
//
// DEFERRALS (tracked follow-ups — NOT documented by this builder yet, stated here
// so the gap is known + intentional):
//   • TanStack / React generator surface — formFile / tanstackQuery / grid + hooks
//     are framework ADD-ONS (a separate front-end-codegen effort); their emitted
//     symbols are out of scope for the back-end public-API IR this builder models.
//   • TPH BASE per-subtype write helpers (create<Sub> / update<Sub>ById /
//     delete<Sub>ById scoped to the shared table) + the subtype REST subpaths —
//     the prior deliberate deferral (see the TPH skip note below). Under-documented
//     (allowed), never invented.
//
// SKIP rules honored (matching the real generators' filters):
//   • object.value records have no primary identity → the queries generator skips
//     them entirely (queries-file.ts `skipNonQueryable` = subType !== "value" &&
//     !isTphSubtype), and they get no CRUD/routes/validation. So value objects
//     contribute ONLY a model symbol here.
//   • TPH subtypes (a @discriminatorValue under a @discriminator base) are ALSO
//     skipped by the queries + routes generators (isTphSubtype, from
//     templates/zod-validators.ts) — their query/route/validation surface lives
//     in the discriminator BASE's polymorphic file, NOT their own. So a TPH
//     subtype likewise contributes ONLY a model symbol here.
//     The discriminator BASE itself stays queryable, but its data-access surface
//     is REDUCED: the queries generator emits only the polymorphic reads
//     find<Base>ById + list<Base>s on the base — create/update/delete are emitted
//     PER CONCRETE SUBTYPE (create<Sub> …), since a base row can't be inserted
//     without choosing a subtype. So the builder documents only those two reads
//     (plus the base's validation schemas + base-path REST, which ARE emitted);
//     documenting create<Base>/update<Base>/delete<Base>ById would be
//     over-documentation (the Task-4 accuracy gate catches exactly that).
//     DEFERRAL: the TPH BASE's per-subtype polymorphic write helpers (create<Sub>
//     / update<Sub>ById / delete<Sub>ById scoped to the shared table) and the
//     subtype REST subpaths are NOT YET documented by this builder — that fuller
//     TPH modeling is a tracked follow-up (under-documentation, allowed).
//   • @emitRoutes:false entities → the routes generator filters them out
//     (routes-file.ts: ownAttr(CODEGEN_ATTR_EMIT_ROUTES) !== false), so they get
//     NO REST symbols here. The queries + validator generators do NOT honor
//     @emitRoutes, so data-access + validation symbols still apply.

import {
  type MetaRoot,
  type MetaObject,
  type MetaData,
  OBJECT_SUBTYPE_VALUE,
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_OUTPUT,
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_FORMAT,
  TEMPLATE_ATTR_KIND,
  TEMPLATE_KIND_EMAIL,
  TEMPLATE_KIND_DEFAULT,
  TYPE_SOURCE,
  SOURCE_ATTR_PARAMETER_REF,
} from "@metaobjectsdev/metadata";
import {
  findByIdFnName,
  listFnName,
  createFnName,
  updateFnName,
  deleteByIdFnName,
  routesHandlerName,
  variableNameFromEntity,
} from "../naming.js";
import { getPkInfo } from "../templates/queries.js";
import { isTphSubtype } from "../templates/zod-validators.js";
import { isTphDiscriminatorBase } from "../templates/tph-discriminator.js";
import { isCallableEntity } from "../templates/callable-file.js";
import { CODEGEN_ATTR_EMIT_ROUTES } from "../constants.js";
import { resourcePath } from "../templates/entity-constants.js";
import { isProjection } from "../projection/projection-detector.js";
import { buildPkMap } from "../pk-resolver.js";
import { buildRelationMap, type RelationEntry, type RelationMap } from "../relation-resolver.js";
import { effectivePackage } from "../docs-paths.js";
import { entityOutputPath, type OutputLayout } from "../import-path.js";
import type { RenderContext } from "../render-context.js";
import type { PkInfo } from "../pk-resolver.js";
import {
  modelFieldShapes,
  createFieldShapes,
  updateFieldShapes,
  payloadFieldShapes,
  type FieldShape,
} from "./api-field-shape.js";

// ---------------------------------------------------------------------------
// Public IR shape.
// ---------------------------------------------------------------------------

export type ApiSymbolKind =
  | "model"
  | "data-access"
  | "rest"
  | "validation"
  | "extractor"
  | "render"
  // T5 additions:
  | "relation" // the drizzle relations() export + per-nav accessors (1:N / M:N)
  | "callable" // call<Entity> stored-proc / table-function wrapper
  | "rest-hono" // the opt-in Hono CRUD registrar variant
  | "prompt"; // render<Name> prompt-render handle for a template.prompt

export interface ApiSymbol {
  /** The exact symbol the real generator emits (function/type/schema name, or
   *  a "METHOD /path" for a REST endpoint). Never invented. */
  name: string;
  kind: ApiSymbolKind;
  /**
   * The module specifier an adopter imports this symbol from — the generated
   * file's path WITHOUT the `.ts` extension, exactly as the EMITTING generator
   * writes it (so it can't drift): e.g. `Product.queries`, `Product`,
   * `ProductSummary.extractor`, `ProductSummary.render`. Package layout folds
   * entity-derived modules under the package path (`acme/shop/Product.queries`)
   * iff the emitting generator does (it keys off the entity's OWN package).
   *
   * REST symbols are NOT importable functions — their importPath is the entity's
   * routes MODULE; `registrar` carries the camelCase `<entity>Routes` handler an
   * adopter mounts (`await <registrar>(fastify)`) to wire the endpoints.
   */
  importPath: string;
  /** REST-only: the route-registrar function exported from `importPath` that an
   *  adopter mounts to wire the endpoints (`<entity>Routes`). Undefined for
   *  importable-symbol kinds (their `name` IS the import). */
  registrar?: string;
  /** A human-readable one-line signature (composed; the param/return SHAPE
   *  mirrors the generated code). For REST symbols this is "METHOD /path". */
  signature: string;
  /** Parameter descriptions, when meaningful. */
  params?: string[];
  /** Return-type description (e.g. "Product | null", "string", "EmailDocument"). */
  returns?: string;
  /** When/why the symbol throws, if it does. */
  throws?: string;
  /** One-line "what you use this for" prose. */
  usage: string;
  /** Optional usage example snippet. */
  example?: string;
  /**
   * The field SHAPE this symbol's payload carries — name + TS type + optionality
   * per field — so both renderers (human field table + agent inline shape) can
   * show WHAT fields to pass, not just the type NAME. Accurate by construction:
   * derived by REUSING the real generators' field walks (api-field-shape.ts), so
   * the api-docs accuracy gate can assert the documented field set == the emitted
   * one. Attached to:
   *   • model            → the entity's inferred fields (model line / GET response);
   *   • create payload    → the InsertSchema field set (create<Name> / POST body);
   *   • update payload    → the UpdateSchema field set (update<Name> / PATCH body);
   *   • extractor payload → the @payloadRef VO interface (extract<Name>'s return).
   * Undefined for symbols with no documented payload shape (e.g. deleteById, list).
   */
  fields?: FieldShape[];
}

export interface ApiUnitDoc {
  /** The metadata node name (entity or template). */
  node: string;
  /** The node's EFFECTIVE package (own package OR the file-default captured at
   *  parse time), used to place the unit's doc page + compute collision-safe
   *  links to it in package layout. Undefined for a package-less node. */
  package?: string | undefined;
  nodeKind: "entity" | "template";
  symbols: ApiSymbol[];
  /**
   * ONE worked, runnable example per unit — a concrete call site an agent (or a
   * human) can copy. ACCURATE BY CONSTRUCTION: it is composed from the SAME
   * symbol NAMES + importPaths this builder already documents (never invented)
   * and the SAME field SHAPES (T2) attached to the unit's payload symbols, with
   * example VALUES derived from each field's TS type (string→"…", number→1,
   * enum→a real member, …) — not entity-hardcoded. The body lines (without
   * imports) are what the agent form shows; the human page wraps the full block
   * (imports + body) in a fenced ```ts.
   *
   * For an ENTITY: a create→find→update→delete flow over the entity's own
   * CRUD helpers. For a TEMPLATE: an extract (parse LLM text) and/or render
   * (produce the document) call. Undefined when a unit has no runnable surface
   * (e.g. a bare value-object model with no queries/template).
   */
  example?: UnitExample;
}

/** A worked example for a unit: the imports it needs (one `import { … } from "…"`
 *  per module, in first-appearance order) + the body statements. Split so the
 *  human page can render a full fenced block and the agent form can show a tight
 *  body. */
export interface UnitExample {
  /** `import { a, b } from "Mod"` lines, deduped by module, reusing the symbols'
   *  own importPaths (never re-derived). */
  imports: string[];
  /** The worked-flow statements (no imports), e.g.
   *  `const created = await createProduct(db, { name: "…" });`. */
  body: string[];
}

export interface ApiModel {
  units: ApiUnitDoc[];
}

/** Minimal context the builder needs. Accepts a full RenderContext OR just the
 *  loaded root (pkMap is derived when absent). Keeping it structural means the
 *  builder runs both inside a gen run and from a thin docs entrypoint. */
export interface ApiModelContext {
  loadedRoot: MetaRoot;
  pkMap?: Map<string, PkInfo>;
  /** The relation map (relation-resolver) the entity file's relations() block is
   *  derived from. Derived from `loadedRoot` when absent — keeps the builder
   *  callable from a thin docs entrypoint. */
  relationMap?: RelationMap;
  /** The output layout the codegen run uses. The per-symbol `importPath` mirrors
   *  the emitting generator's own path computation under this layout (flat →
   *  `Product.queries`; package → folded under the entity's package path iff the
   *  generator folds). Defaults to "flat" (today's byte-identical placement). */
  outputLayout?: OutputLayout;
  /** Whether to ALSO document the OPT-IN Hono CRUD variant (routesFileHono).
   *  Hono is not in the default generator suite — it is an alternative wired by
   *  the adopter — so its symbols are documented ONLY when the adopter opts in
   *  (mirrors "match the generator's filters": don't over-document a surface the
   *  run didn't configure). The Fastify REST surface is always documented (it is
   *  the default-suite routes generator). Defaults to false. */
  includeHonoRoutes?: boolean;
}

// ---------------------------------------------------------------------------
// Builder.
// ---------------------------------------------------------------------------

export function buildApiModel(root: MetaRoot, ctx: ApiModelContext): ApiModel {
  const pkMap = ctx.pkMap ?? buildPkMap(root);
  // getPkInfo wants a RenderContext; it only reads `.pkMap`, so a structural
  // shim is sufficient (and avoids forcing callers to build a full context).
  const pkCtx = { pkMap } as RenderContext;
  const layout = ctx.outputLayout ?? "flat";
  const relationMap = ctx.relationMap ?? buildRelationMap(root);
  const includeHono = ctx.includeHonoRoutes ?? false;

  const units: ApiUnitDoc[] = [];

  for (const obj of root.objects()) {
    units.push(buildEntityUnit(obj, pkCtx, root, layout, relationMap, includeHono));
  }

  for (const tmpl of templateOutputs(root)) {
    units.push(buildTemplateUnit(tmpl, root, layout));
  }

  for (const tmpl of templatePrompts(root)) {
    units.push(buildPromptUnit(tmpl, root));
  }

  return { units };
}

// ---------------------------------------------------------------------------
// importPath derivation — the SINGLE place a documented symbol's import module
// is computed. It mirrors the EMITTING generator's own path logic exactly so a
// documented import can never drift from where the code actually lands:
//
//   • entity / queries / routes files use
//       entityOutputPath(layout, entity.package, "<Name>.<suffix>.ts")
//     (queries-file.ts / entity-file.ts / routes-file.ts) — note they key off
//     the entity's OWN bare `.package` (often undefined for objects, FR5d), so
//     in package layout they only fold when the object actually carries a
//     package. We pass the SAME `obj.package` here, not effectivePackage.
//   • extractor / render-helper files emit a FLAT `<Name>.extractor.ts` /
//     `<Name>.render.ts` regardless of layout (extractor-file.ts /
//     render-helper-file.ts: `${t.name}.<suffix>.ts`, no package folding).
//
// The importPath is the emitted path WITHOUT the trailing `.ts`.
// ---------------------------------------------------------------------------

/** Extension-less module specifier for an entity-derived file
 *  (`<Name>` / `<Name>.queries` / `<Name>.routes`), folded by the SAME
 *  entityOutputPath logic the emitting generator uses. */
function entityModulePath(layout: OutputLayout, obj: MetaObject, basename: string): string {
  return stripTs(entityOutputPath(layout, obj.package, `${basename}.ts`));
}

/** Extension-less module specifier for a template-derived file
 *  (`<Name>.extractor` / `<Name>.render`) — always flat (the generators do not
 *  fold these by package). */
function templateModulePath(basename: string): string {
  return basename;
}

function stripTs(path: string): string {
  return path.endsWith(".ts") ? path.slice(0, -3) : path;
}

// ---------------------------------------------------------------------------
// Entities.
// ---------------------------------------------------------------------------

/** Mirror of the queries generator's filter (queries-file.ts `skipNonQueryable`
 *  = `subType !== OBJECT_SUBTYPE_VALUE && !isTphSubtype`). A queryable entity is
 *  any non-value, non-TPH-subtype object:
 *   • Value objects have no primary identity → the queries/routes/validation
 *     generators emit no CRUD for them.
 *   • TPH subtypes (@discriminatorValue under a @discriminator base) emit no
 *     standalone queries/routes file — their surface lives in the discriminator
 *     BASE's polymorphic file (routes-file.ts:27 + queries-file.ts:21-22).
 *  Either way the object contributes only a model symbol here. (The TPH base's
 *  per-subtype polymorphic helpers + subpaths are a documented deferral — see
 *  the module header.) */
function isQueryable(obj: MetaObject): boolean {
  return obj.subType !== OBJECT_SUBTYPE_VALUE && !isTphSubtype(obj);
}

/** Whether the routes generator emits REST routes for this entity. It filters
 *  out @emitRoutes:false (routes-file.ts:27), unlike the queries + validator
 *  generators which always emit. So REST symbols are gated separately from the
 *  other queryable kinds. */
function emitsRoutes(obj: MetaObject): boolean {
  return obj.ownAttr(CODEGEN_ATTR_EMIT_ROUTES) !== false;
}

function buildEntityUnit(
  obj: MetaObject,
  ctx: RenderContext,
  root: MetaRoot,
  layout: OutputLayout,
  relationMap: RelationMap,
  includeHono: boolean,
): ApiUnitDoc {
  const name = obj.name;
  const symbols: ApiSymbol[] = [];

  // The entity MODEL + its zod schemas are emitted into `<Name>.ts` (entity-file
  // composes drizzle-schema + inferred-types + zod-validators), so model AND
  // validation share the entity module's importPath.
  const entityMod = entityModulePath(layout, obj, name);

  // --- model: the entity type/const the entity-file generator emits (bare name). ---
  symbols.push({
    name,
    kind: "model",
    importPath: entityMod,
    signature: `interface ${name}`,
    returns: name,
    usage: `The typed shape of a ${name} row, generated from its metadata.`,
    fields: modelFieldShapes(obj),
  });

  if (isQueryable(obj)) {
    symbols.push(...dataAccessSymbols(obj, ctx, root, layout));
    symbols.push(...validationSymbols(obj, entityMod));
    // REST is additionally gated: @emitRoutes:false suppresses routes only.
    if (emitsRoutes(obj)) {
      symbols.push(...restSymbols(obj, layout));
      // The OPT-IN Hono variant mounts the SAME CRUD verbs under the SAME
      // @emitRoutes filter — documented only when the adopter wired it.
      if (includeHono) symbols.push(...restHonoSymbols(obj, layout));
    }
  }

  // --- relation: the drizzle relations() export, when the resolver derives a
  //     relations() block for this entity (1:N belongs-to + inverse many, M:N
  //     @through). Independent of isQueryable — a relations() block is emitted by
  //     the entity file regardless. ---
  const relationSym = relationSymbol(obj, entityMod, relationMap);
  if (relationSym !== undefined) symbols.push(relationSym);

  // --- callable: call<Entity>, only when the entity is backed by a stored-proc /
  //     table-function source (matching the callable generator's isCallableEntity
  //     filter). ---
  const callableSym = callableSymbol(obj, root, layout);
  if (callableSym !== undefined) symbols.push(callableSym);

  const unit: ApiUnitDoc = {
    node: name,
    package: effectivePackage(obj),
    nodeKind: "entity",
    symbols,
  };
  // The worked example reads the row back by its REAL primary key (e.g.
  // `created.code`), not a hard-coded `id` — reuse the same getPkInfo the
  // data-access symbols were named from so the example is accurate-by-
  // construction for any PK field name.
  const pkName = getPkInfo(obj, ctx).fieldName;
  const example = entityExample(name, pkName, symbols);
  if (example !== undefined) unit.example = example;
  return unit;
}

/** The CRUD helpers templates/queries.ts emits, named via the SHARED naming
 *  helpers the template itself uses (so the names cannot drift). The PK field +
 *  TS type come from the real getPkInfo.
 *
 *  TPH discriminator BASE divergence: when `obj` is a discriminator base, the
 *  queries generator does NOT emit standalone create<Base>/update<Base>/
 *  delete<Base>ById — a base row can't be inserted without choosing a concrete
 *  subtype, so write helpers are emitted PER CONCRETE SUBTYPE (create<Sub> …),
 *  not on the base. The base file emits only the polymorphic reads find<Base>ById
 *  + list<Base>s. Documenting create<Base>/update<Base>/delete<Base>ById would be
 *  OVER-documentation (the api-docs accuracy gate catches exactly this). The
 *  per-subtype write helpers themselves are a tracked deferral (module header),
 *  so we under-document (allowed) rather than invent names. */
function dataAccessSymbols(
  obj: MetaObject,
  ctx: RenderContext,
  root: MetaRoot,
  layout: OutputLayout,
): ApiSymbol[] {
  const name = obj.name;
  const { fieldName: pk, tsType: pkType } = getPkInfo(obj, ctx);

  // All CRUD helpers are emitted into `<Name>.queries.ts` (queries-file.ts).
  const mod = entityModulePath(layout, obj, `${name}.queries`);

  const find = findByIdFnName(name);
  const list = listFnName(name);
  const create = createFnName(name);
  const update = updateFnName(name);
  const del = deleteByIdFnName(name);

  const reads: ApiSymbol[] = [
    {
      name: find,
      kind: "data-access",
      importPath: mod,
      signature: `${find}(db: Db, ${pk}: ${pkType}): Promise<${name} | null>`,
      params: [`db: Db`, `${pk}: ${pkType}`],
      returns: `Promise<${name} | null>`,
      usage: `Fetch a single ${name} by its primary key; null when not found.`,
    },
    {
      name: list,
      kind: "data-access",
      importPath: mod,
      signature: `${list}(db: Db, opts?: { limit?: number; offset?: number }): Promise<${name}[]>`,
      params: [`db: Db`, `opts?: { limit?: number; offset?: number }`],
      returns: `Promise<${name}[]>`,
      usage: `List ${name} rows with optional limit/offset paging.`,
    },
  ];

  // A TPH discriminator base emits ONLY the polymorphic reads — the write
  // helpers are per concrete subtype (create<Sub> …), not on the base.
  if (isTphDiscriminatorBase(obj, root)) {
    return reads;
  }

  // Create/update payload shapes — the EXACT InsertSchema/UpdateSchema field sets
  // (api-field-shape reuses the zod emitter's own walk), so `data: unknown`'s
  // real shape is documented + gate-verified against the emitted schema.
  const createShape = createFieldShapes(obj);
  const updateShape = updateFieldShapes(obj);

  return [
    ...reads,
    {
      name: create,
      kind: "data-access",
      importPath: mod,
      signature: `${create}(db: Db, data: unknown): Promise<${name}>`,
      params: [`db: Db`, `data: unknown`],
      returns: `Promise<${name}>`,
      throws: `ZodError when data fails ${name}InsertSchema validation.`,
      usage: `Validate (via ${name}InsertSchema) and insert a new ${name}.`,
      fields: createShape,
    },
    {
      name: update,
      kind: "data-access",
      importPath: mod,
      signature: `${update}(db: Db, ${pk}: ${pkType}, data: unknown): Promise<${name} | null>`,
      params: [`db: Db`, `${pk}: ${pkType}`, `data: unknown`],
      returns: `Promise<${name} | null>`,
      throws: `ZodError when data fails the partial ${name}InsertSchema validation.`,
      usage: `Partially update an existing ${name} by primary key; null when not found.`,
      fields: updateShape,
    },
    {
      name: del,
      kind: "data-access",
      importPath: mod,
      signature: `${del}(db: Db, ${pk}: ${pkType}): Promise<boolean>`,
      params: [`db: Db`, `${pk}: ${pkType}`],
      returns: `Promise<boolean>`,
      usage: `Delete a ${name} by primary key; true when a row was removed.`,
    },
  ];
}

/** The two zod schemas the validator generator emits per entity. The route +
 *  queries generators import these exact names (<Name>InsertSchema /
 *  <Name>UpdateSchema), so the spelling is verified against their usage. */
function validationSymbols(obj: MetaObject, entityMod: string): ApiSymbol[] {
  const name = obj.name;
  // The zod schemas are composed INTO the entity file (entity-file.ts calls
  // renderZodValidators), so they import from the same `<Name>` module. The
  // documented field shapes ARE those schemas' accepted shapes.
  return [
    {
      name: `${name}InsertSchema`,
      kind: "validation",
      importPath: entityMod,
      signature: `${name}InsertSchema: ZodType`,
      returns: `ZodType`,
      usage: `Zod schema validating the body of a create<${name}> / POST request (auto-generated PKs excluded).`,
      fields: createFieldShapes(obj),
    },
    {
      name: `${name}UpdateSchema`,
      kind: "validation",
      importPath: entityMod,
      signature: `${name}UpdateSchema: ZodType`,
      returns: `ZodType`,
      usage: `Zod schema validating the body of an update / PATCH request (all fields optional).`,
      fields: updateFieldShapes(obj),
    },
  ];
}

/**
 * The REST endpoints the routes generator mounts for an entity. The routes
 * generator does NOT emit one function per verb — it emits a single
 * `<name>Routes(fastify)` handler that mounts the standard CRUD verb set at the
 * entity's $path via mountCrudRoutes (or the read-only subset via
 * mountReadOnlyCrudRoutes for a projection). We reuse resourcePath() — the same
 * function entity-constants.ts uses to compute $path — so the documented paths
 * match the generated routes exactly. The verb→path mapping mirrors the runtime
 * mountCrudRoutes contract referenced in routes-file.ts's comments.
 */
function restSymbols(obj: MetaObject, layout: OutputLayout): ApiSymbol[] {
  const name = obj.name;
  const path = resourcePath(obj);
  const readOnly = isProjection(obj);

  // REST endpoints are not importable functions — to WIRE them an adopter
  // imports the entity's route registrar (`<entity>Routes`) from the routes
  // module the routes generator emits (`<Name>.routes.ts`) and mounts it:
  //   import { <registrar> } from "<routesMod>"; await <registrar>(fastify);
  // Every endpoint of one entity shares that single registrar import.
  const routesMod = entityModulePath(layout, obj, `${name}.routes`);
  const registrar = routesHandlerName(name);

  // The REST bodies/responses ARE the same gate-verified shapes: a GET returns
  // the model shape, POST takes the create shape, PATCH takes the update shape.
  const modelShape = modelFieldShapes(obj);
  const createShape = createFieldShapes(obj);
  const updateShape = updateFieldShapes(obj);

  const ep = restEndpointFactory("rest", routesMod, registrar);

  const symbols: ApiSymbol[] = [
    ep("GET", path, `List ${name} (supports filter/sort/paging query params).`, modelShape),
    ep("GET", `${path}/:id`, `Fetch a single ${name} by id (404 when not found).`, modelShape),
  ];

  if (!readOnly) {
    symbols.push(
      ep("POST", path, `Create a ${name} (body validated by ${name}InsertSchema).`, createShape),
      ep("PATCH", `${path}/:id`, `Partially update a ${name} by id (body validated by ${name}UpdateSchema).`, updateShape),
      ep("DELETE", `${path}/:id`, `Delete a ${name} by id.`),
    );
  }

  return symbols;
}

/** Build a REST endpoint symbol factory bound to one route surface (kind +
 *  route module + registrar). The Fastify and Hono REST builders share this so a
 *  `METHOD /path` endpoint is shaped one way; only the surface-level kind/module/
 *  registrar and the per-endpoint description differ between them. */
function restEndpointFactory(
  kind: ApiSymbolKind,
  routesMod: string,
  registrar: string,
): (method: string, p: string, desc: string, fields?: FieldShape[]) => ApiSymbol {
  return (method, p, desc, fields) => {
    const sym: ApiSymbol = {
      name: `${method} ${p}`,
      kind,
      importPath: routesMod,
      registrar,
      signature: `${method} ${p}`,
      usage: desc,
    };
    if (fields !== undefined) sym.fields = fields;
    return sym;
  };
}

// ---------------------------------------------------------------------------
// T5: relations / callable / Hono (entity-level), then prompt (template.prompt).
// ---------------------------------------------------------------------------

/**
 * The drizzle relations() export the entity file composes for an entity that has
 * relations. The relations-block generator emits
 *   `export const <var>Relations = relations(<var>, ({ one, many }) => ({ … }))`
 * where `<var> = variableNameFromEntity(name)` (so `Post` → `postRelations`) and
 * the body is one accessor per RelationEntry the resolver derived — `author:
 * one(User, …)` for a 1:N belongs-to, `tags: many(PostTag)` for an M:N @through,
 * and the inverse `posts: many(…)` registered on the target. We document the
 * EXPORT (the importable symbol) and ride each navigation in the field shape
 * (name → cardinality-tagged target), all derived from the SAME RelationMap the
 * generator emits from — never invented. Returns undefined when the resolver
 * derived no relations() block for this entity (the entity file emits none).
 */
function relationSymbol(
  obj: MetaObject,
  entityMod: string,
  relationMap: RelationMap,
): ApiSymbol | undefined {
  const entries = relationMap.get(obj.name);
  if (entries === undefined || entries.length === 0) return undefined;

  const varName = variableNameFromEntity(obj.name);
  const relationsExport = `${varName}Relations`;

  // One field-shape row per navigation: name is the relation accessor key the
  // block emits; type carries the cardinality + the entity you traverse to; note
  // explains how to query it via the relational API.
  const navFields: FieldShape[] = entries.map((e) => relationNavField(e));

  return {
    name: relationsExport,
    kind: "relation",
    importPath: entityMod,
    signature: `const ${relationsExport}: Relations<"${tableName(varName)}", …>`,
    returns: relationsExport,
    usage:
      `Drizzle relations() for ${obj.name} — register it with your schema, then ` +
      `traverse via the relational query API (db.query.${varName}.findMany({ with: { … } })).`,
    fields: navFields,
  };
}

/** Drizzle's relations() first arg is the table var; we only need a stable label
 *  here for the signature, so reuse the entity's table var name. */
function tableName(varName: string): string {
  return varName;
}

/** A field-shape row describing ONE relation navigation: accessor name + a
 *  cardinality-tagged target "type" + a how-to-traverse note. Mirrors the
 *  RelationEntry the resolver produced (1:N one() / M:N many(junction) / inverse
 *  many()), never restated. */
function relationNavField(e: RelationEntry): FieldShape {
  if (e.cardinality === "one") {
    return {
      name: e.name,
      type: `${e.targetEntity} (1:1 / N:1)`,
      optional: true,
      note: `belongs-to → ${e.targetEntity}${e.fkField ? ` via ${e.fkField}` : ""}`,
    };
  }
  // many — either a M:N through a junction or a 1:N inverse.
  if (e.junctionEntity !== undefined) {
    return {
      name: e.name,
      type: `${e.targetEntity}[] (M:N via ${e.junctionEntity})`,
      optional: true,
      note: `many-to-many → ${e.targetEntity} through ${e.junctionEntity}`,
    };
  }
  return {
    name: e.name,
    type: `${e.targetEntity}[] (1:N)`,
    optional: true,
    note: `has-many → ${e.targetEntity}`,
  };
}

/**
 * The callable wrapper `call<Entity>` the callable generator emits for an entity
 * backed by a stored-proc / table-function source (isCallableEntity — the SAME
 * filter the generator factory uses). The wrapper takes `(db, args: <argsVO>)`
 * (or just `(db)` for a zero-arg proc) and returns `Promise<<Entity>[]>`, emitted
 * into a FLAT-OR-PACKAGE-FOLDED `<Entity>.callable.ts` (entityOutputPath, same as
 * the generator). Returns undefined for a non-callable entity (no file emitted).
 */
function callableSymbol(
  obj: MetaObject,
  root: MetaRoot,
  layout: OutputLayout,
): ApiSymbol | undefined {
  if (!isCallableEntity(obj)) return undefined;

  const name = obj.name;
  const fn = `call${name}`;
  const mod = entityModulePath(layout, obj, `${name}.callable`);

  // Resolve the @parameterRef args value-object name (same resolution the
  // callable template uses) to type the `args` param — undefined ⇒ zero-arg proc.
  const argsRef = callableArgsRef(obj, root);
  const signature = argsRef
    ? `${fn}(db: NodePgDatabase, args: ${argsRef}): Promise<${name}[]>`
    : `${fn}(db: NodePgDatabase): Promise<${name}[]>`;
  const params = argsRef
    ? [`db: NodePgDatabase`, `args: ${argsRef}`]
    : [`db: NodePgDatabase`];

  return {
    name: fn,
    kind: "callable",
    importPath: mod,
    signature,
    params,
    returns: `${name}[]`,
    usage: `Call the ${name} stored procedure / table function and parse each row into a typed ${name}.`,
  };
}

/** The @parameterRef value-object name for a callable entity's source, or
 *  undefined for a zero-arg proc. Mirrors the callable template's resolution
 *  (the source child's SOURCE_ATTR_PARAMETER_REF). */
function callableArgsRef(obj: MetaObject, root: MetaRoot): string | undefined {
  for (const child of obj.ownChildren()) {
    if (child.type !== TYPE_SOURCE) continue;
    const ref = child.ownAttr(SOURCE_ATTR_PARAMETER_REF);
    if (typeof ref === "string" && ref !== "") {
      // Only count it when it resolves to a value object (the template's guard).
      const vo = root
        .ownChildren()
        .find((c) => c.subType === OBJECT_SUBTYPE_VALUE && c.name === ref);
      if (vo !== undefined) return ref;
    }
  }
  return undefined;
}

/**
 * The OPT-IN Hono CRUD registrar `register<Entity>Routes(app, deps)` the
 * routesFileHono generator emits into `<Entity>.routes.hono.ts`. Parallels the
 * Fastify restSymbols (same verb set, same resourcePath, read-only for
 * projections) but carries the Hono registrar name + import module. Documented
 * only when the adopter opts into the Hono variant (includeHonoRoutes).
 */
function restHonoSymbols(obj: MetaObject, layout: OutputLayout): ApiSymbol[] {
  const name = obj.name;
  const path = resourcePath(obj);
  const readOnly = isProjection(obj);

  const honoMod = entityModulePath(layout, obj, `${name}.routes.hono`);
  const registrar = `register${name}Routes`;

  const modelShape = modelFieldShapes(obj);
  const createShape = createFieldShapes(obj);
  const updateShape = updateFieldShapes(obj);

  const ep = restEndpointFactory("rest-hono", honoMod, registrar);

  const symbols: ApiSymbol[] = [
    ep("GET", path, `[Hono] List ${name} (filter/sort/paging query params).`, modelShape),
    ep("GET", `${path}/:id`, `[Hono] Fetch a single ${name} by id (404 when not found).`, modelShape),
  ];

  if (!readOnly) {
    symbols.push(
      ep("POST", path, `[Hono] Create a ${name} (body validated by ${name}InsertSchema).`, createShape),
      ep("PATCH", `${path}/:id`, `[Hono] Partially update a ${name} by id (body validated by ${name}UpdateSchema).`, updateShape),
      ep("DELETE", `${path}/:id`, `[Hono] Delete a ${name} by id.`),
    );
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// template.output nodes.
// ---------------------------------------------------------------------------

function templateOutputs(root: MetaRoot): MetaData[] {
  return root
    .ownChildren()
    .filter((c) => c.type === TYPE_TEMPLATE && c.subType === TEMPLATE_SUBTYPE_OUTPUT);
}

function buildTemplateUnit(tmpl: MetaData, root: MetaRoot, _layout: OutputLayout): ApiUnitDoc {
  const name = tmpl.name;
  const symbols: ApiSymbol[] = [];
  // extractor + render-helper generators emit FLAT `<Name>.extractor.ts` /
  // `<Name>.render.ts` (no package folding), so importPath ignores layout.
  const extractorMod = templateModulePath(`${name}.extractor`);
  const renderMod = templateModulePath(`${name}.render`);

  const payloadRef = tmpl.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
  const payload = typeof payloadRef === "string" ? payloadRef : undefined;
  const format = ((tmpl.ownAttr(TEMPLATE_ATTR_FORMAT) as string | undefined) ?? "text").toLowerCase();
  const kind = ((tmpl.ownAttr(TEMPLATE_ATTR_KIND) as string | undefined) ?? TEMPLATE_KIND_DEFAULT).toLowerCase();

  // --- extractor: only json/xml output-parsers expose the extract API (matches
  //     extractor-file.ts's `if (format !== "json" && format !== "xml") continue`). ---
  if (payload && (format === "json" || format === "xml")) {
    const extract = `extract${name}`;
    const extractLenient = `extractLenient${name}`;
    // The extractor's strict return IS the @payloadRef value-object's interface —
    // document its field shape (same VO field walk the payload interface emitter
    // uses) so an agent sees what `extract<Name>` yields, not just the type name.
    const payloadShape = payloadFieldShapes(root, payload);
    const extractSym: ApiSymbol = {
      name: extract,
      kind: "extractor",
      importPath: extractorMod,
      signature: `${extract}(root: MetaRoot, text: string): ${payload}`,
      params: [`root: MetaRoot`, `text: string`],
      returns: payload,
      throws: `Error when a @required field is lost (the strict opt-in gate).`,
      usage: `Parse dirty LLM ${format} text into a strict, fully-typed ${payload} graph.`,
    };
    if (payloadShape !== undefined) extractSym.fields = payloadShape;
    symbols.push(
      extractSym,
      {
        name: extractLenient,
        kind: "extractor",
        importPath: extractorMod,
        signature: `${extractLenient}(root: MetaRoot, text: string): ExtractionResult<${name}Extracted>`,
        params: [`root: MetaRoot`, `text: string`],
        returns: `ExtractionResult<${name}Extracted>`,
        usage: `Never-throwing extract; inspect report for lost/defaulted fields.`,
      },
    );
  }

  // --- render: render<Name>; document → string, email → EmailDocument
  //     (matches render-helper.ts's @kind branch). Render is emitted for any
  //     @format (the helper wraps render() regardless), so it is NOT format-gated. ---
  if (payload) {
    const render = `render${name}`;
    const isEmail = kind === TEMPLATE_KIND_EMAIL;
    const returns = isEmail ? "EmailDocument" : "string";
    symbols.push({
      name: render,
      kind: "render",
      importPath: renderMod,
      signature: `${render}(payload: ${payload}, provider: Provider): ${returns}`,
      params: [`payload: ${payload}`, `provider: Provider`],
      returns,
      usage: isEmail
        ? `Render the ${name} email (subject + bodies) from a typed ${payload} payload.`
        : `Render the ${name} document from a typed ${payload} payload.`,
    });
  }

  const unit: ApiUnitDoc = {
    node: name,
    package: effectivePackage(tmpl),
    nodeKind: "template",
    symbols,
  };
  const example = templateExample(name, symbols);
  if (example !== undefined) unit.example = example;
  return unit;
}

// ---------------------------------------------------------------------------
// template.prompt nodes — the prompt-render handle.
// ---------------------------------------------------------------------------

/** TOP-LEVEL template.prompt nodes — matching the promptRender generator's own
 *  collection (`ctx.loadedRoot.ownChildren()` filtered to TYPE_TEMPLATE +
 *  TEMPLATE_SUBTYPE_PROMPT). A prompt nested INSIDE an entity is not collected by
 *  the generator, so the builder must not document it either (no over-doc). */
function templatePrompts(root: MetaRoot): MetaData[] {
  return root
    .ownChildren()
    .filter((c) => c.type === TYPE_TEMPLATE && c.subType === TEMPLATE_SUBTYPE_PROMPT);
}

/**
 * The render handle promptRender() emits per template.prompt — generateRenderHandle
 * (payload-codegen.ts) produces
 *   `export function render<Name>(payload: <payloadRef>, provider: Provider): string`
 * and promptRender aggregates every handle into a SINGLE file (default outFile
 * "prompts.ts"), so the import module is the bare `prompts` (no package folding;
 * the generator writes the outFile verbatim). The payload field shape is the
 * @payloadRef VO interface (same walk the payload-interface emitter uses), so an
 * agent sees what to pass.
 */
function buildPromptUnit(tmpl: MetaData, root: MetaRoot): ApiUnitDoc {
  const name = tmpl.name;
  const symbols: ApiSymbol[] = [];
  // promptRender writes the aggregated handles to `outFile` (default "prompts.ts").
  const promptsMod = templateModulePath("prompts");

  const payloadRef = tmpl.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
  const payload = typeof payloadRef === "string" ? payloadRef : undefined;

  if (payload) {
    const render = `render${name}`;
    const sym: ApiSymbol = {
      name: render,
      kind: "prompt",
      importPath: promptsMod,
      signature: `${render}(payload: ${payload}, provider: Provider): string`,
      params: [`payload: ${payload}`, `provider: Provider`],
      returns: "string",
      usage: `Render the ${name} prompt text from a typed ${payload} payload (ready to send to an LLM).`,
    };
    const payloadShape = payloadFieldShapes(root, payload);
    if (payloadShape !== undefined) sym.fields = payloadShape;
    symbols.push(sym);
  }

  return {
    node: name,
    package: effectivePackage(tmpl),
    nodeKind: "template",
    symbols,
  };
}

// ---------------------------------------------------------------------------
// Worked examples — composed from the symbols already documented above (their
// real names + importPaths) and the field SHAPES (T2) attached to the payload
// symbols, with VALUES derived from each field's TS type. Nothing is invented:
// a symbol that isn't in `symbols` is never called, and an import never names a
// module a documented symbol doesn't already point at.
// ---------------------------------------------------------------------------

/** A sample literal for a documented field, derived from its TS type STRING
 *  (T2's `FieldShape.type`) — never from the entity. Enum unions yield a real
 *  member; arrays an empty list; scalars a type-appropriate placeholder. */
function sampleValueForType(type: string): string {
  const t = type.trim();
  // Enum / string-literal union (`"active" | "archived"`): use the first member
  // verbatim so the example is a REAL accepted value.
  const firstLiteral = t.match(/^"([^"]*)"/);
  if (firstLiteral) return `"${firstLiteral[1]}"`;
  if (t.endsWith("[]")) return "[]";
  if (t === "number") return "1";
  if (t === "bigint") return "1n";
  if (t === "boolean") return "true";
  if (t === "Date") return "new Date()";
  if (t === "string") return `"…"`;
  // Unknown / object / nested type: a typed-object placeholder keeps the call
  // shape intact without inventing a fake member set.
  return "{}";
}

/** Build a `{ field: value; … }` object literal from a payload field shape,
 *  using only the REQUIRED fields plus the first optional (so an agent sees a
 *  minimal-but-real body) — values derived from each field's TS type. */
function objectLiteralFromFields(fields: FieldShape[] | undefined): string {
  if (fields === undefined || fields.length === 0) return "{}";
  const required = fields.filter((f) => !f.optional);
  // If nothing is strictly required, show the first field so the body isn't `{}`.
  const chosen = required.length > 0 ? required : fields.slice(0, 1);
  const parts = chosen.map((f) => `${f.name}: ${sampleValueForType(f.type)}`);
  return `{ ${parts.join(", ")} }`;
}

/** One `import { … } from "<mod>"` line per module, deduped, reusing each
 *  symbol's OWN importPath (so the example import can't drift from the docs). */
function importLines(picks: { name: string; importPath: string }[]): string[] {
  const order: string[] = [];
  const byMod = new Map<string, string[]>();
  for (const p of picks) {
    let names = byMod.get(p.importPath);
    if (names === undefined) {
      names = [];
      byMod.set(p.importPath, names);
      order.push(p.importPath);
    }
    if (!names.includes(p.name)) names.push(p.name);
  }
  return order.map((mod) => `import { ${byMod.get(mod)!.join(", ")} } from "${mod}";`);
}

/** A worked create→find→update→delete flow over an entity's documented CRUD
 *  helpers. Only emitted when the entity actually carries those data-access
 *  symbols (a value object / TPH subtype has only a model → no example).
 *
 *  `pkName` is the entity's REAL primary-key field (from getPkInfo) — the
 *  find/update/delete calls read it back as `created.<pkName>`, so the example
 *  stays accurate-by-construction for an entity whose PK is not named `id`. */
function entityExample(name: string, pkName: string, symbols: ApiSymbol[]): UnitExample | undefined {
  const da = (fn: string) => symbols.find((s) => s.kind === "data-access" && s.name === fn);
  const create = da(createFnName(name));
  const find = da(findByIdFnName(name));
  const update = da(updateFnName(name));
  const del = da(deleteByIdFnName(name));
  // Need at least create+find to have a meaningful worked flow.
  if (create === undefined || find === undefined) return undefined;

  const createBody = objectLiteralFromFields(create.fields);
  // The handle returned by create<Name> exposes the row's real PK accessor.
  const createdPk = `created.${pkName}`;
  const picks: { name: string; importPath: string }[] = [
    { name: create.name, importPath: create.importPath },
    { name: find.name, importPath: find.importPath },
  ];
  const body: string[] = [
    `const created = await ${create.name}(db, ${createBody});`,
    `const found = await ${find.name}(db, ${createdPk});`,
  ];
  if (update !== undefined) {
    picks.push({ name: update.name, importPath: update.importPath });
    body.push(`const updated = await ${update.name}(db, ${createdPk}, ${objectLiteralFromFields(update.fields)});`);
  }
  if (del !== undefined) {
    picks.push({ name: del.name, importPath: del.importPath });
    body.push(`const removed = await ${del.name}(db, ${createdPk});`);
  }
  return { imports: importLines(picks), body };
}

/** A worked extract / render example for a template unit, over whichever of the
 *  two surfaces the template actually exposes (extract is json/xml-gated). */
function templateExample(name: string, symbols: ApiSymbol[]): UnitExample | undefined {
  const extract = symbols.find((s) => s.kind === "extractor" && s.name === `extract${name}`);
  const renderSym = symbols.find((s) => s.kind === "render" && s.name === `render${name}`);
  if (extract === undefined && renderSym === undefined) return undefined;

  const picks: { name: string; importPath: string }[] = [];
  const body: string[] = [];
  if (extract !== undefined) {
    picks.push({ name: extract.name, importPath: extract.importPath });
    body.push(`const extracted = ${extract.name}(root, llmText);`);
  }
  if (renderSym !== undefined) {
    picks.push({ name: renderSym.name, importPath: renderSym.importPath });
    // Render's payload object literal comes from the @payloadRef VO shape the
    // render symbol returns/consumes; reuse the extractor's documented payload
    // fields when present so the example body is real.
    const payloadFields = extract?.fields;
    const payloadLit = objectLiteralFromFields(payloadFields);
    body.push(`const output = ${renderSym.name}(${payloadLit}, provider);`);
  }
  return { imports: importLines(picks), body };
}
