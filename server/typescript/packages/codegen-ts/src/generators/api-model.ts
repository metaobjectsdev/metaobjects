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
//     them entirely (queries-file.ts `skipValueTypes` = subType !== "value"), and
//     they get no CRUD/routes/validation. So value objects contribute ONLY a
//     model symbol here.

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
} from "../naming.js";
import { getPkInfo } from "../templates/queries.js";
import { resourcePath } from "../templates/entity-constants.js";
import { isProjection } from "../projection/projection-detector.js";
import { buildPkMap } from "../pk-resolver.js";
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
}

// ---------------------------------------------------------------------------
// Builder.
// ---------------------------------------------------------------------------

export function buildApiModel(root: MetaRoot, ctx: ApiModelContext): ApiModel {
  const pkMap = ctx.pkMap ?? buildPkMap(root);
  // getPkInfo wants a RenderContext; it only reads `.pkMap`, so a structural
  // shim is sufficient (and avoids forcing callers to build a full context).
  const pkCtx = { pkMap } as RenderContext;

  const units: ApiUnitDoc[] = [];

  for (const obj of root.objects()) {
    units.push(buildEntityUnit(obj, pkCtx));
  }

  for (const tmpl of templateOutputs(root)) {
    units.push(buildTemplateUnit(tmpl, root));
  }

  return { units };
}

// ---------------------------------------------------------------------------
// Entities.
// ---------------------------------------------------------------------------

/** Mirror of the queries generator's filter (queries-file.ts `skipValueTypes`):
 *  a queryable entity is any non-value object. Value objects have no primary
 *  identity, so the queries/routes/validation generators emit no CRUD for them
 *  and they contribute only a model symbol here. */
function isQueryable(obj: MetaObject): boolean {
  return obj.subType !== OBJECT_SUBTYPE_VALUE;
}

function buildEntityUnit(obj: MetaObject, ctx: RenderContext): ApiUnitDoc {
  const name = obj.name;
  const symbols: ApiSymbol[] = [];

  // --- model: the entity type/const the entity-file generator emits (bare name). ---
  symbols.push({
    name,
    kind: "model",
    signature: `interface ${name}`,
    returns: name,
    usage: `The typed shape of a ${name} row, generated from its metadata.`,
  });

  if (isQueryable(obj)) {
    symbols.push(...dataAccessSymbols(obj, ctx));
    symbols.push(...validationSymbols(obj));
    symbols.push(...restSymbols(obj));
  }

  return { node: name, nodeKind: "entity", symbols };
}

/** The CRUD helpers templates/queries.ts emits, named via the SHARED naming
 *  helpers the template itself uses (so the names cannot drift). The PK field +
 *  TS type come from the real getPkInfo. */
function dataAccessSymbols(obj: MetaObject, ctx: RenderContext): ApiSymbol[] {
  const name = obj.name;
  const { fieldName: pk, tsType: pkType } = getPkInfo(obj, ctx);

  const find = findByIdFnName(name);
  const list = listFnName(name);
  const create = createFnName(name);
  const update = updateFnName(name);
  const del = deleteByIdFnName(name);

  return [
    {
      name: find,
      kind: "data-access",
      signature: `${find}(db: Db, ${pk}: ${pkType}): Promise<${name} | null>`,
      params: [`db: Db`, `${pk}: ${pkType}`],
      returns: `Promise<${name} | null>`,
      usage: `Fetch a single ${name} by its primary key; null when not found.`,
    },
    {
      name: list,
      kind: "data-access",
      signature: `${list}(db: Db, opts?: { limit?: number; offset?: number }): Promise<${name}[]>`,
      params: [`db: Db`, `opts?: { limit?: number; offset?: number }`],
      returns: `Promise<${name}[]>`,
      usage: `List ${name} rows with optional limit/offset paging.`,
    },
    {
      name: create,
      kind: "data-access",
      signature: `${create}(db: Db, data: unknown): Promise<${name}>`,
      params: [`db: Db`, `data: unknown`],
      returns: `Promise<${name}>`,
      throws: `ZodError when data fails ${name}InsertSchema validation.`,
      usage: `Validate (via ${name}InsertSchema) and insert a new ${name}.`,
    },
    {
      name: update,
      kind: "data-access",
      signature: `${update}(db: Db, ${pk}: ${pkType}, data: unknown): Promise<${name} | null>`,
      params: [`db: Db`, `${pk}: ${pkType}`, `data: unknown`],
      returns: `Promise<${name} | null>`,
      throws: `ZodError when data fails the partial ${name}InsertSchema validation.`,
      usage: `Partially update an existing ${name} by primary key; null when not found.`,
    },
    {
      name: del,
      kind: "data-access",
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
function validationSymbols(obj: MetaObject): ApiSymbol[] {
  const name = obj.name;
  return [
    {
      name: `${name}InsertSchema`,
      kind: "validation",
      signature: `${name}InsertSchema: ZodType`,
      returns: `ZodType`,
      usage: `Zod schema validating the body of a create<${name}> / POST request (auto-generated PKs excluded).`,
    },
    {
      name: `${name}UpdateSchema`,
      kind: "validation",
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
function restSymbols(obj: MetaObject): ApiSymbol[] {
  const name = obj.name;
  const path = resourcePath(obj);
  const readOnly = isProjection(obj);

  const get = (p: string, desc: string): ApiSymbol => ({
    name: `GET ${p}`,
    kind: "rest",
    signature: `GET ${p}`,
    usage: desc,
  });

  const symbols: ApiSymbol[] = [
    get(path, `List ${name} (supports filter/sort/paging query params).`),
    get(`${path}/:id`, `Fetch a single ${name} by id (404 when not found).`),
  ];

  if (!readOnly) {
    symbols.push(
      {
        name: `POST ${path}`,
        kind: "rest",
        signature: `POST ${path}`,
        usage: `Create a ${name} (body validated by ${name}InsertSchema).`,
      },
      {
        name: `PATCH ${path}/:id`,
        kind: "rest",
        signature: `PATCH ${path}/:id`,
        usage: `Partially update a ${name} by id (body validated by ${name}UpdateSchema).`,
      },
      {
        name: `DELETE ${path}/:id`,
        kind: "rest",
        signature: `DELETE ${path}/:id`,
        usage: `Delete a ${name} by id.`,
      },
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

function buildTemplateUnit(tmpl: MetaData, root: MetaRoot): ApiUnitDoc {
  const name = tmpl.name;
  const symbols: ApiSymbol[] = [];

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
        signature: `${extract}(root: MetaRoot, text: string): ${payload}`,
        params: [`root: MetaRoot`, `text: string`],
        returns: payload,
        throws: `Error when a @required field is lost (the strict opt-in gate).`,
        usage: `Parse dirty LLM ${format} text into a strict, fully-typed ${payload} graph.`,
      },
      {
        name: extractLenient,
        kind: "extractor",
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
      signature: `${render}(payload: ${payload}, provider: Provider): ${returns}`,
      params: [`payload: ${payload}`, `provider: Provider`],
      returns,
      usage: isEmail
        ? `Render the ${name} email (subject + bodies) from a typed ${payload} payload.`
        : `Render the ${name} document from a typed ${payload} payload.`,
    });
  }

  return { node: name, nodeKind: "template", symbols };
}
