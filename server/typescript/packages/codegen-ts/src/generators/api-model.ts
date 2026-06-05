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
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_FORMAT,
  TEMPLATE_ATTR_KIND,
  TEMPLATE_KIND_EMAIL,
  TEMPLATE_KIND_DEFAULT,
} from "@metaobjectsdev/metadata";
import {
  findByIdFnName,
  listFnName,
  createFnName,
  updateFnName,
  deleteByIdFnName,
  routesHandlerName,
} from "../naming.js";
import { getPkInfo } from "../templates/queries.js";
import { isTphSubtype } from "../templates/zod-validators.js";
import { isTphDiscriminatorBase } from "../templates/tph-discriminator.js";
import { CODEGEN_ATTR_EMIT_ROUTES } from "../constants.js";
import { resourcePath } from "../templates/entity-constants.js";
import { isProjection } from "../projection/projection-detector.js";
import { buildPkMap } from "../pk-resolver.js";
import { effectivePackage } from "../docs-paths.js";
import { entityOutputPath, type OutputLayout } from "../import-path.js";
import type { RenderContext } from "../render-context.js";
import type { PkInfo } from "../pk-resolver.js";

// ---------------------------------------------------------------------------
// Public IR shape.
// ---------------------------------------------------------------------------

export type ApiSymbolKind =
  | "model"
  | "data-access"
  | "rest"
  | "validation"
  | "extractor"
  | "render";

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
  /** The output layout the codegen run uses. The per-symbol `importPath` mirrors
   *  the emitting generator's own path computation under this layout (flat →
   *  `Product.queries`; package → folded under the entity's package path iff the
   *  generator folds). Defaults to "flat" (today's byte-identical placement). */
  outputLayout?: OutputLayout;
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

  const units: ApiUnitDoc[] = [];

  for (const obj of root.objects()) {
    units.push(buildEntityUnit(obj, pkCtx, root, layout));
  }

  for (const tmpl of templateOutputs(root)) {
    units.push(buildTemplateUnit(tmpl, root, layout));
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
  });

  if (isQueryable(obj)) {
    symbols.push(...dataAccessSymbols(obj, ctx, root, layout));
    symbols.push(...validationSymbols(obj, entityMod));
    // REST is additionally gated: @emitRoutes:false suppresses routes only.
    if (emitsRoutes(obj)) {
      symbols.push(...restSymbols(obj, layout));
    }
  }

  return { node: name, package: effectivePackage(obj), nodeKind: "entity", symbols };
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
  // renderZodValidators), so they import from the same `<Name>` module.
  return [
    {
      name: `${name}InsertSchema`,
      kind: "validation",
      importPath: entityMod,
      signature: `${name}InsertSchema: ZodType`,
      returns: `ZodType`,
      usage: `Zod schema validating the body of a create<${name}> / POST request (auto-generated PKs excluded).`,
    },
    {
      name: `${name}UpdateSchema`,
      kind: "validation",
      importPath: entityMod,
      signature: `${name}UpdateSchema: ZodType`,
      returns: `ZodType`,
      usage: `Zod schema validating the body of an update / PATCH request (all fields optional).`,
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

  const ep = (method: string, p: string, desc: string): ApiSymbol => ({
    name: `${method} ${p}`,
    kind: "rest",
    importPath: routesMod,
    registrar,
    signature: `${method} ${p}`,
    usage: desc,
  });

  const symbols: ApiSymbol[] = [
    ep("GET", path, `List ${name} (supports filter/sort/paging query params).`),
    ep("GET", `${path}/:id`, `Fetch a single ${name} by id (404 when not found).`),
  ];

  if (!readOnly) {
    symbols.push(
      ep("POST", path, `Create a ${name} (body validated by ${name}InsertSchema).`),
      ep("PATCH", `${path}/:id`, `Partially update a ${name} by id (body validated by ${name}UpdateSchema).`),
      ep("DELETE", `${path}/:id`, `Delete a ${name} by id.`),
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
    symbols.push(
      {
        name: extract,
        kind: "extractor",
        importPath: extractorMod,
        signature: `${extract}(root: MetaRoot, text: string): ${payload}`,
        params: [`root: MetaRoot`, `text: string`],
        returns: payload,
        throws: `Error when a @required field is lost (the strict opt-in gate).`,
        usage: `Parse dirty LLM ${format} text into a strict, fully-typed ${payload} graph.`,
      },
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

  return { node: name, package: effectivePackage(tmpl), nodeKind: "template", symbols };
}
