// FR-022 — the OpenAPI 3.1 document of the generated REST surface: the contract in
// docs/features/api-contract.md, which every port's routes answer, narrowed to the verbs a project
// mounts. `components.schemas` is the canonical JSON Schema (an OpenAPI 3.1 schema IS JSON Schema
// 2020-12), so the two artifacts cannot disagree.
//
// It states the list parameters of the REST contract: one per filterable field and operator,
// `?search` when the row has text fields it matches, and the `filter[or]` / `filter[and]`
// combinators (ADR-0068). It does not state the `405` refusals on a read-only surface, which are
// not operations a caller can use (the api docs omit them for the same reason): a read-only
// resource says so in the description of its operations instead.
//
// It also states what the 1.3 routes do beyond the happy path: the project's page size
// (`api.pagination`), the refusal of an undeclared body key (`api.unknownFields`) and the list of
// validation issues.

import { flatSurfaceFields } from "../flattened.js";
import {
  type ApiPagination,
  apiPaginationOf,
  apiUnknownFieldsOf,
  type MetaField,
  type MetaObject,
  type MetaRoot,
  opsForField,
  UNKNOWN_FIELDS_REJECT,
} from "@metaobjectsdev/metadata";
import { FIELD_SUBTYPE_ENUM, FIELD_SUBTYPE_TIMESTAMP, FILTER_OP_IN, FILTER_OP_IS_NULL, FILTER_OP_LIKE } from "@metaobjectsdev/metadata/constants";
import { hasItemRoute, itemRouteField, servedPath, servesReadApi } from "../api-surface.js";
import { isProjection } from "../projection/projection-detector.js";
import type { RelationMap } from "../relation-resolver.js";
import { CRUD_VERBS, type CrudVerb, type ExposeOption, intersectExpose, resolveExpose, TPH_POLYMORPHIC_VERBS } from "../routes-expose.js";
import { isReport } from "../source-detect.js";
import { credentialFieldNames, isFilterableField, sortableFields } from "../templates/filter-shared.js";
import { isSearchField } from "../templates/filter-allowlist.js";
import { tphPlan } from "../templates/tph-discriminator.js";
import { isTphSubtype } from "../tph.js";
import { ContractEmitError, ERR_CONTRACT_NAME_COLLISION } from "./contract-errors.js";
import { type ContractShape, enumSchema, type JsonSchema, scalarSchema, timestampInputSchema } from "./field-schema.js";
import { collectContractEntries, type ContractTarget } from "./object-schema.js";

export const OPENAPI_VERSION = "3.1.0";

/** The error envelope's component. A collision with a real object is refused like any other. */
const ERROR_COMPONENT = "ApiError";

const SHAPE_SUFFIX: Record<ContractShape, string> = { read: "", create: "Create", update: "Update" };

const SORT_DIRECTIONS = ["asc", "desc"] as const;

export interface OpenApiDocumentOptions {
  /** `info.title`. */
  readonly title?: string;
  /** `info.version`: the version of YOUR API, not of MetaObjects. */
  readonly version?: string;
  /** `info.description`. */
  readonly description?: string;
  /** `servers`, as OpenAPI spells it. A deployment fact: metadata does not hold it. */
  readonly servers?: readonly Record<string, unknown>[];
  /** `components.securitySchemes`, as OpenAPI spells it. Authentication is the application's. */
  readonly securitySchemes?: Record<string, unknown>;
  /** The top-level `security` requirement, as OpenAPI spells it. */
  readonly security?: readonly Record<string, readonly string[]>[];
}

export interface OpenApiBuildInput extends OpenApiDocumentOptions {
  readonly root: MetaRoot;
  /** The objects the document covers. */
  readonly objects: readonly MetaObject[];
  readonly apiPrefix: string;
  readonly relationMap: RelationMap;
  /** The verbs the routes generators mount. Undefined mounts every verb. */
  readonly expose?: ExposeOption;
  /** Whether an object has routes at all, when a routes generator's `filter` narrows them. */
  readonly mounted?: (obj: MetaObject) => boolean;
  /** Whether `report-export` is wired, which adds `?format=` to a served report. */
  readonly reportExport: boolean;
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byName(a: MetaObject, b: MetaObject): number {
  return compareNames(a.name, b.name);
}

function componentName(obj: MetaObject, shape: ContractShape): string {
  return `${obj.name}${SHAPE_SUFFIX[shape]}`;
}

function componentRef(name: string): string {
  return `#/components/schemas/${name}`;
}

function shapeRef(obj: MetaObject, shape: ContractShape): JsonSchema {
  return { $ref: componentRef(componentName(obj, shape)) };
}

/**
 * What the paths point at, gathered as they are built. A path can name a shape nothing else in the
 * document reaches, such as the target of a traversal when the generator's `filter` leaves it out.
 */
interface PathRefs {
  readonly shapes: ContractTarget[];
  /** The objects a list route answers, for their list components. */
  readonly listed: Set<MetaObject>;
}

function pathRef(refs: PathRefs, obj: MetaObject, shape: ContractShape): JsonSchema {
  refs.shapes.push({ obj, shape });
  return shapeRef(obj, shape);
}

function jsonContent(schema: JsonSchema): JsonSchema {
  return { "application/json": { schema } };
}

function errorResponse(description: string): JsonSchema {
  return { description, content: jsonContent({ $ref: componentRef(ERROR_COMPONENT) }) };
}

const READ_ONLY_NOTE = 'Read-only: a write to this resource answers 405 {"error": "method_not_allowed"}.';

const BAD_REQUEST = errorResponse("The request was refused.");
const VALIDATION_REFUSED = errorResponse(
  'The request was refused. A body that fails validation answers error "validation" with an issue for every problem, not the first.',
);
const UNKNOWN_FIELDS_REFUSED = errorResponse(
  'The request was refused. A body key the model does not declare answers error "unknown_fields" with the keys in fields, and nothing is written. Any other problem answers error "validation" with an issue for every problem.',
);
const NOT_FOUND = errorResponse("No such row.");
const INVALID_ID = errorResponse('The id is not one the key column can hold: error "invalid_id".');
const CONFLICT = errorResponse("A constraint refused the write.");

/** The value of one filter operator, in the query string. */
function filterValueSchema(field: MetaField, op: string): JsonSchema {
  if (op === FILTER_OP_IS_NULL) return { type: "boolean" };
  if (op === FILTER_OP_IN) return { type: "string", description: "Comma-separated values." };
  if (op === FILTER_OP_LIKE) return { type: "string" };
  if (field.subType === FIELD_SUBTYPE_TIMESTAMP) return timestampInputSchema(field);
  if (field.subType === FIELD_SUBTYPE_ENUM) return enumSchema(field);
  return scalarSchema(field.subType);
}

/** The fields on the server's filter allowlist, in declaration order. */
function filterableFields(obj: MetaObject, excludeField: string | undefined, root: MetaRoot): MetaField[] {
  // A column a sibling subtype of one table marks as a credential is refused by the server allowlist too.
  const credentials = credentialFieldNames(obj, root);
  return flatSurfaceFields(obj).filter((f) => isFilterableField(f) && !credentials.has(f.name) && f.name !== excludeField);
}

/**
 * The cap on `or` / `and` nesting every port serves (the list-query contract, ADR-0068): the
 * sixth level answers 400 `filter.nesting_too_deep`.
 */
const FILTER_MAX_NESTING = 5;

/**
 * `?search`, when the allowlist has a field it matches (with none, the server ignores the
 * parameter, so the document does not offer it), and the boolean combinators, when there is a
 * filter at all. A combinator nests, which a query parameter's schema cannot spell, so each is one
 * `deepObject` parameter whose description gives the grammar.
 */
function listQueryParameters(filterable: readonly MetaField[]): JsonSchema[] {
  if (!filterable.some((f) => opsForField(f).length > 0)) return [];
  const searched = filterable.filter(isSearchField).map((f) => f.name);
  const search: JsonSchema[] = searched.length === 0 ? [] : [{
    name: "search",
    in: "query",
    description: `A case-insensitive substring match across ${searched.join(", ")}, ORed together. Empty, it is no search.`,
    schema: { type: "string" },
  }];
  const combinator = (op: "or" | "and", joined: string): JsonSchema => ({
    name: `filter[${op}]`,
    in: "query",
    style: "deepObject",
    explode: true,
    description:
      `Branches ${joined} together: filter[${op}][N][<field>][<op>]=<value>, each branch a filter of its own that may nest ` +
      `filter[or] and filter[and]. Branches are taken in index order. ${FILTER_MAX_NESTING} levels are served; ` +
      `the next answers 400 filter.nesting_too_deep.`,
    schema: { type: "object", additionalProperties: { type: "object" } },
  });
  return [...search, combinator("or", "ORed"), combinator("and", "ANDed")];
}

/** One parameter per filterable field and operator, so removing either is a visible change. */
function filterParameters(filterable: readonly MetaField[]): JsonSchema[] {
  const params: JsonSchema[] = [];
  for (const field of filterable) {
    const ops = opsForField(field);
    if (ops.length === 0) continue;
    params.push({ name: `filter[${field.name}]`, in: "query", description: "Sugar for the eq operator.", schema: filterValueSchema(field, ops[0] ?? "") });
    for (const op of ops) {
      params.push({ name: `filter[${field.name}][${op}]`, in: "query", schema: filterValueSchema(field, op) });
    }
  }
  return params;
}

function sortParameter(obj: MetaObject, excludeField: string | undefined, root: MetaRoot): JsonSchema[] {
  const fields = sortableFields(obj, root).filter((f) => f.name !== excludeField);
  if (fields.length === 0) return [];
  const values = fields.flatMap((f) => [f.name, ...SORT_DIRECTIONS.map((d) => `${f.name}:${d}`)]);
  return [{ name: "sort", in: "query", schema: { type: "string", enum: values } }];
}

/**
 * The page parameters. A project that sets `api.pagination` serves `defaultLimit` rows when `limit`
 * is absent and refuses a `limit` above `maxLimit`, so the document says both. A report keeps its
 * own row cap (a generator option the model does not hold), so it states neither.
 */
function pageParameters(minLimit: number, page: ApiPagination | undefined): JsonSchema[] {
  const limit: JsonSchema = {
    type: "integer",
    minimum: minLimit,
    ...(page !== undefined && { maximum: page.maxLimit, default: page.defaultLimit }),
  };
  return [
    {
      name: "limit",
      in: "query",
      ...(page !== undefined && {
        description: `Rows per page. Absent, the server answers ${page.defaultLimit}; above ${page.maxLimit} it answers 400 limit_too_large.`,
      }),
      schema: limit,
    },
    { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
    { name: "withCount", in: "query", description: "Answer { rows, total } instead of the array.", schema: { type: "integer", enum: [1] } },
  ];
}

function listComponent(row: MetaObject): string {
  return `${row.name}List`;
}

function pageComponent(row: MetaObject): string {
  return `${row.name}Page`;
}

/**
 * A list answers an array, or `{ rows, total }` under `withCount=1`. Each is a named component
 * because a diff tool pairs a `oneOf` by name: inline, adding a field to the row reads as two
 * subschemas replaced, and oasdiff reports a compatible change as a breaking one.
 */
function listSchema(row: MetaObject): JsonSchema {
  return { oneOf: [{ $ref: componentRef(listComponent(row)) }, { $ref: componentRef(pageComponent(row)) }] };
}

function listComponents(row: MetaObject): Record<string, JsonSchema> {
  const rows = { type: "array", items: shapeRef(row, "read") };
  return {
    [listComponent(row)]: { title: listComponent(row), ...rows },
    [pageComponent(row)]: {
      title: pageComponent(row),
      type: "object",
      required: ["rows", "total"],
      properties: { rows, total: { type: "integer" } },
    },
  };
}

function idParameter(obj: MetaObject): JsonSchema {
  const name = itemRouteField(obj);
  const field = obj.fields().find((f) => f.name === name);
  return { name: "id", in: "path", required: true, schema: field === undefined ? { type: "string" } : scalarSchema(field.subType) };
}

/** The operations of one resource: its collection path and, when it has rows by key, its item path. */
interface ResourceOps {
  /** Writes are not served here (a projection or a report), and the operations say so. */
  readonly readOnly?: boolean;
  /** The object whose rows the routes answer, and whose name the operations carry. */
  readonly row: MetaObject;
  readonly path: string;
  readonly verbs: ReadonlySet<CrudVerb>;
  /** Filtering and sorting on this field is refused: a per-subtype mount pins the discriminator. */
  readonly excludeField?: string;
  readonly report: boolean;
  readonly reportExport: boolean;
  readonly item: boolean;
  readonly refs: PathRefs;
  /** The loaded model: a credential column is read across the single-table hierarchy it sits in. */
  readonly root: MetaRoot;
}

function listOperation(r: ResourceOps): JsonSchema {
  const { row } = r;
  const filterable = filterableFields(row, r.excludeField, r.root);
  const parameters = [
    ...filterParameters(filterable),
    ...listQueryParameters(filterable),
    ...sortParameter(row, r.excludeField, r.root),
    ...pageParameters(r.report ? 1 : 0, r.report ? undefined : apiPaginationOf(r.root)),
    ...(r.reportExport ? [{ name: "format", in: "query", schema: { type: "string", enum: ["csv", "json", "xml"] } }] : []),
  ];
  r.refs.listed.add(row);
  r.refs.shapes.push({ obj: row, shape: "read" });
  const content = jsonContent(listSchema(row));
  const exports = r.reportExport ? { "text/csv": { schema: { type: "string" } }, "application/xml": { schema: { type: "string" } } } : {};
  return {
    operationId: `list${row.name}`,
    tags: [row.name],
    ...(r.readOnly === true && { description: READ_ONLY_NOTE }),
    parameters,
    responses: { "200": { description: "The rows.", content: { ...content, ...exports } }, "400": BAD_REQUEST },
  };
}

function writeBody(r: ResourceOps, shape: ContractShape): JsonSchema {
  const rejects = apiUnknownFieldsOf(r.root) === UNKNOWN_FIELDS_REJECT;
  const description = rejects
    ? "A top-level key the model does not declare is refused with 400 unknown_fields. A declared key the client may not set, such as the generated key, is dropped."
    : "A top-level key the model does not declare is dropped, and the rest of the body is written.";
  return { required: true, description, content: jsonContent(pathRef(r.refs, r.row, shape)) };
}

const INVALID_ID_NOTE = ' An id the key column cannot hold answers error "invalid_id".';

function writeRefused(r: ResourceOps, byId = false): JsonSchema {
  const refused = apiUnknownFieldsOf(r.root) === UNKNOWN_FIELDS_REJECT ? UNKNOWN_FIELDS_REFUSED : VALIDATION_REFUSED;
  return byId ? { ...refused, description: `${String(refused["description"])}${INVALID_ID_NOTE}` } : refused;
}

function updateOperation(r: ResourceOps, operationId: string): JsonSchema {
  return {
    operationId,
    tags: [r.row.name],
    requestBody: writeBody(r, "update"),
    responses: {
      "200": { description: "The row.", content: jsonContent(pathRef(r.refs, r.row, "read")) },
      "400": writeRefused(r, true),
      "404": NOT_FOUND,
      "409": CONFLICT,
    },
  };
}

function itemOperations(r: ResourceOps): JsonSchema {
  const { row, verbs } = r;
  const tags = [row.name];
  return {
    ...(verbs.has("get") && {
      get: {
        operationId: `get${row.name}`,
        tags,
        ...(r.readOnly === true && { description: READ_ONLY_NOTE }),
        responses: { "200": { description: "The row.", content: jsonContent(pathRef(r.refs, row, "read")) }, "400": INVALID_ID, "404": NOT_FOUND },
      },
    }),
    ...(verbs.has("update") && {
      patch: updateOperation(r, `update${row.name}`),
      // The contract's PUT is an alias of PATCH: a partial update, not a replacement.
      put: updateOperation(r, `put${row.name}`),
    }),
    ...(verbs.has("delete") && {
      delete: {
        operationId: `delete${row.name}`,
        tags,
        responses: { "204": { description: "Deleted." }, "400": INVALID_ID, "404": NOT_FOUND, "409": CONFLICT },
      },
    }),
  };
}

function collectionOperations(r: ResourceOps): JsonSchema {
  const { row, verbs } = r;
  return {
    ...(verbs.has("list") && { get: listOperation(r) }),
    ...(verbs.has("create") && {
      post: {
        operationId: `create${row.name}`,
        tags: [row.name],
        requestBody: writeBody(r, "create"),
        responses: {
          "201": { description: "The new row.", content: jsonContent(pathRef(r.refs, row, "read")) },
          "400": writeRefused(r),
          "409": CONFLICT,
        },
      },
    }),
  };
}

function resourcePaths(r: ResourceOps): Record<string, JsonSchema> {
  const paths: Record<string, JsonSchema> = {};
  const collection = collectionOperations(r);
  if (Object.keys(collection).length > 0) paths[r.path] = collection;
  const item = r.item ? itemOperations(r) : {};
  if (Object.keys(item).length > 0) paths[`${r.path}/{id}`] = { parameters: [idParameter(r.row)], ...item };
  return paths;
}

/** `GET <source>/{id}/<relation>`: the M:N traversal, an array of the target's rows. */
function m2mPaths(source: MetaObject, path: string, relationMap: RelationMap, refs: PathRefs): Record<string, JsonSchema> {
  const paths: Record<string, JsonSchema> = {};
  for (const entry of relationMap.get(source.name) ?? []) {
    if (entry.junctionEntity === undefined) continue;
    paths[`${path}/{id}/${entry.name}`] = {
      parameters: [idParameter(source)],
      get: {
        operationId: `list${source.name}${entry.name.charAt(0).toUpperCase()}${entry.name.slice(1)}`,
        tags: [source.name],
        responses: {
          "200": { description: "The related rows.", content: jsonContent({ type: "array", items: pathRef(refs, entry.target, "read") }) },
        },
      },
    };
  }
  return paths;
}

function verbsOf(fixed: readonly CrudVerb[], obj: MetaObject, expose: ExposeOption | undefined): ReadonlySet<CrudVerb> {
  return new Set<CrudVerb>(intersectExpose([...fixed], resolveExpose(obj, expose)));
}

function pathsOf(obj: MetaObject, input: OpenApiBuildInput, refs: PathRefs): Record<string, JsonSchema> {
  const { root, apiPrefix, expose, relationMap } = input;
  const path = servedPath(obj, apiPrefix);
  const report = isReport(obj);
  if (isProjection(obj)) {
    return resourcePaths({
      row: obj, path, report, reportExport: report && input.reportExport, item: hasItemRoute(obj), refs, root: input.root,
      readOnly: true, verbs: new Set<CrudVerb>(["list", "get"]),
    });
  }
  const plan = tphPlan(obj, root);
  const paths: Record<string, JsonSchema> = {
    ...resourcePaths({ row: obj, path, report: false, reportExport: false, item: true, refs, root: input.root, verbs: verbsOf(plan === null ? CRUD_VERBS : TPH_POLYMORPHIC_VERBS, obj, expose) }),
    ...m2mPaths(obj, path, relationMap, refs),
  };
  if (plan === null) return paths;
  for (const { entity, routeSegment } of plan.subtypes) {
    const subPath = `${path}/${routeSegment}`;
    Object.assign(paths, resourcePaths({
      row: entity, path: subPath, report: false, reportExport: false, item: true, refs, root: input.root,
      verbs: verbsOf(CRUD_VERBS, obj, expose), excludeField: plan.discriminatorField,
    }), m2mPaths(entity, subPath, relationMap, refs));
  }
  return paths;
}

/** An `operationId` is unique in a document, and a client generator names a method after it. */
function refuseDuplicateOperationIds(paths: Record<string, JsonSchema>): void {
  const seen = new Map<string, string>();
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      const id = (operation as JsonSchema).operationId;
      if (typeof id !== "string") continue;
      const here = `${method.toUpperCase()} ${path}`;
      const other = seen.get(id);
      if (other !== undefined) {
        throw new ContractEmitError(
          ERR_CONTRACT_NAME_COLLISION,
          `the OpenAPI operationId '${id}' is both ${other} and ${here}. Rename one, or leave one out with the generator's filter option.`,
        );
      }
      seen.set(id, here);
    }
  }
}

function collectSchemas(input: OpenApiBuildInput, refs: PathRefs): Record<string, JsonSchema> {
  const taken = new Map<string, string>([[ERROR_COMPONENT, "the error envelope"]]);
  const schemas: Record<string, JsonSchema> = {};
  function claim(name: string, holder: string): void {
    const other = taken.get(name);
    if (other !== undefined) {
      throw new ContractEmitError(
        ERR_CONTRACT_NAME_COLLISION,
        `the OpenAPI component '${name}' is both ${other} and ${holder}. Rename one, or leave one out with the generator's filter option.`,
      );
    }
    taken.set(name, holder);
  }
  const entries = collectContractEntries(
    input.objects,
    input.root,
    (_from, target, shape) => componentRef(componentName(target, shape)),
    { openApiDiscriminator: true, referenced: refs.shapes },
  );
  for (const { obj, shape, schema } of entries) {
    const name = componentName(obj, shape);
    claim(name, `'${obj.resolutionKey()}' (${shape} shape)`);
    schemas[name] = { title: name, ...schema };
  }
  for (const row of refs.listed) {
    for (const [name, schema] of Object.entries(listComponents(row))) {
      claim(name, `the list response of '${row.resolutionKey()}'`);
      schemas[name] = schema;
    }
  }
  schemas[ERROR_COMPONENT] = {
    title: ERROR_COMPONENT,
    description: "The error envelope. `error` is the stable code; `message` is free prose.",
    type: "object",
    required: ["error"],
    properties: {
      error: { type: "string" },
      message: { type: "string" },
      field: { type: "string", description: "The rejected filter or sort field, on the four codes that name one." },
      fields: { type: "array", items: { type: "string" }, description: "The undeclared body keys, sorted, on unknown_fields." },
      issues: {
        type: "array",
        description: "Every problem with the body, on validation.",
        items: {
          type: "object",
          required: ["code", "path", "message"],
          properties: {
            code: { type: "string", description: "A Zod issue name. A client that does not know one treats it as custom." },
            path: { type: "array", items: { oneOf: [{ type: "string" }, { type: "integer" }] }, description: "The location of the field in the body." },
            message: { type: "string" },
          },
        },
      },
      maxLimit: { type: "integer", description: "The largest page the server serves, on limit_too_large." },
    },
  };
  return Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => compareNames(a, b)));
}

/** The whole document, in the key order it is written. */
export function buildOpenApiDocument(input: OpenApiBuildInput): JsonSchema {
  const objects = [...input.objects].sort(byName);
  const served = objects.filter((o) => servesReadApi(o) && !isTphSubtype(o) && (input.mounted?.(o) ?? true));
  const paths: Record<string, JsonSchema> = {};
  const refs: PathRefs = { shapes: [], listed: new Set() };
  for (const obj of served) Object.assign(paths, pathsOf(obj, input, refs));
  refuseDuplicateOperationIds(paths);
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: input.title ?? "API",
      version: input.version ?? "0.0.0",
      ...(input.description !== undefined && { description: input.description }),
    },
    ...(input.servers !== undefined && { servers: input.servers }),
    ...(input.security !== undefined && { security: input.security }),
    paths,
    components: {
      schemas: collectSchemas({ ...input, objects }, refs),
      ...(input.securitySchemes !== undefined && { securitySchemes: input.securitySchemes }),
    },
  };
}

