/**
 * Every REST route this example serves, mounted ONCE for all entities.
 *
 * The generated routes are one file per entity, written at `meta gen` time. This is five
 * handlers with a `:collection` parameter, and each one asks the loaded model what that
 * collection is: which entity, which fields a body may carry, which fields a list may be
 * filtered and sorted on, how large a page may be. Add an entity to the metadata and it is
 * served; nothing here names one.
 *
 * It answers with the wire contract the generated routes use (docs/features/api-contract.md):
 * the same paths, verbs, status codes and error bodies.
 */
import {
  apiPaginationOf,
  apiUnknownFieldsOf,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_FORM_EXCLUDE,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  GENERATION_ASSIGNED,
  IDENTITY_ATTR_GENERATION,
  type MetaObject,
} from "@metaobjectsdev/metadata";
import {
  META_CONTENT_TYPE,
  META_ROUTE_PATH,
  metaJson,
  runValidators,
  ValidationError,
  withConstraintMapping,
  type ObjectManager,
  type Row,
  type ValidationFailure,
} from "@metaobjectsdev/runtime-ts";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isCredential, isRecord, ListQueryError, readListQuery } from "./list-query";
import { declaredValueIssues, type WriteIssue } from "./write-checks";
import { SERVED_ROUTE_PATH, type ServedInfo } from "../served";
import type { Model } from "./runtime";

const ERROR_NOT_FOUND = "not_found";
const ERROR_VALIDATION = "validation";
const ERROR_UNKNOWN_FIELDS = "unknown_fields";
const ERROR_INVALID_JSON = "invalid_json";
const ERROR_INTERNAL = "internal";
const UNKNOWN_FIELDS_REJECT = "reject";

export type { WriteIssue } from "./write-checks";

/** What a business rule is shown before a row is written. */
export interface PendingWrite {
  /** The entity name, as the metadata declares it. */
  readonly entity: string;
  readonly verb: "create" | "update";
  /**
   * The row as it will stand after the write: on create, the body over the model's declared
   * defaults; on update, the body over the stored row.
   */
  readonly next: Readonly<Row>;
  /** On update, the row as it stands now, so a rule can tell what the write changes. */
  readonly stored?: Readonly<Row>;
  readonly om: ObjectManager;
}

/**
 * A hand-written rule the metadata cannot express. It returns the issues that stop the
 * write, or none. This is where business logic lives; see `business-rules.ts`.
 */
export type WriteRule = (write: PendingWrite) => readonly WriteIssue[] | Promise<readonly WriteIssue[]>;

export interface DynamicRoutesOptions {
  readonly fastify: FastifyInstance;
  /** Where the collections mount, e.g. `/api`. */
  readonly prefix: string;
  /** The model in force right now. Asked on every request, so a reload needs no re-mount. */
  readonly model: () => Model;
  readonly rules?: readonly WriteRule[];
}

/** The primary-key fields the database fills in; empty when the caller assigns the key. */
function generatedKeyFields(entity: MetaObject): readonly string[] {
  const primary = entity.primaryIdentity();
  return primary === undefined || primary.attr(IDENTITY_ATTR_GENERATION) === GENERATION_ASSIGNED ? [] : primary.fields;
}

/** The values a new row takes for the fields its body leaves out: the model's `@default`s. */
function declaredDefaults(entity: MetaObject): Row {
  const defaults: Row = {};
  for (const field of entity.fields()) {
    const value = field.attr(FIELD_ATTR_DEFAULT);
    if (value !== undefined) defaults[field.name] = value;
  }
  return defaults;
}

const WHOLE_NUMBER_KEYS: ReadonlySet<string> = new Set([FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG]);

/**
 * The key a path segment names, or undefined when it is not how this entity's key is
 * written. A whole-number key has one address, its plain decimal form: `0x1`, `1e0` and
 * `01` all read as 1 to a lenient parser, and one row must not answer at several URLs.
 */
function rowKey(entity: MetaObject, text: string): string | undefined {
  const keyName = entity.primaryIdentity()?.fields[0];
  const key = keyName === undefined ? undefined : entity.findField(keyName);
  if (key === undefined || !WHOLE_NUMBER_KEYS.has(key.subType)) return text;
  const n = Number(text);
  return Number.isSafeInteger(n) && String(n) === text ? text : undefined;
}

/**
 * The fields a request body may set: every field of the entity except a primary key the
 * database generates, a credential, and a field marked `@formExclude`. The generated
 * insert and update schemas leave the same ones out.
 */
function writableFieldNames(entity: MetaObject): ReadonlySet<string> {
  const names = new Set(
    entity.fields().filter((field) => !isCredential(field) && field.attr(FIELD_ATTR_FORM_EXCLUDE) !== true).map((field) => field.name),
  );
  for (const name of generatedKeyFields(entity)) names.delete(name);
  return names;
}

/**
 * Turns a stored row of `entity` into what a response carries: the row without the
 * entity's credentials. The fields are looked up once, not once a row.
 */
function shownBy(entity: MetaObject): (row: Row) => Row {
  const hidden = entity.fields().filter(isCredential).map((field) => field.name);
  if (hidden.length === 0) return (row) => row;
  return (row) => {
    const out: Row = { ...row };
    for (const name of hidden) delete out[name];
    return out;
  };
}

function toIssue(failure: ValidationFailure): WriteIssue {
  return { path: [failure.field], code: failure.rule, message: failure.message };
}

function validation(reply: FastifyReply, issues: readonly WriteIssue[]): FastifyReply {
  return reply.code(400).send({ error: ERROR_VALIDATION, issues });
}

/**
 * Read a write body against the entity, or answer the 400 and return undefined.
 *
 * A key the entity does not declare is refused before anything is validated, unless the
 * project chose `api.unknownFields: "drop"`, in which case it is removed.
 */
function readBody(model: Model, entity: MetaObject, body: unknown, reply: FastifyReply): Row | undefined {
  if (!isRecord(body)) {
    validation(reply, [{ path: [], code: "invalid_type", message: "The body must be a JSON object." }]);
    return undefined;
  }
  const writable = writableFieldNames(entity);
  // Sorted by code point, so the same request gets the same answer from every port.
  const unknown = Object.keys(body).filter((key) => !writable.has(key)).sort();
  if (unknown.length > 0 && apiUnknownFieldsOf(model.root) === UNKNOWN_FIELDS_REJECT) {
    reply.code(400).send({ error: ERROR_UNKNOWN_FIELDS, fields: unknown });
    return undefined;
  }
  const row: Row = {};
  for (const [key, value] of Object.entries(body)) {
    if (writable.has(key)) row[key] = value;
  }
  return row;
}

/**
 * Run a write, and answer what can go wrong with it: a value the metadata's validators
 * refuse (400 `validation`), or a constraint the database enforces (409, or 400 for a
 * check). Anything else is logged here and leaves as a 500 that says nothing about it.
 */
async function answerWrite(reply: FastifyReply, write: () => Promise<FastifyReply>): Promise<FastifyReply> {
  return withConstraintMapping(
    async () => {
      try {
        return await write();
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        return validation(reply, err.errors.map(toIssue));
      }
    },
    (failure) => reply.code(failure.status).send(failure.body),
    (err) => reply.log.error(err),
  );
}

/**
 * What stops a write: the metadata's own validators first, then the hand-written rules.
 * A rule therefore only ever sees a body the model already accepts.
 */
async function writeIssues(
  rules: readonly WriteRule[],
  entity: MetaObject,
  body: Row,
  write: PendingWrite,
): Promise<readonly WriteIssue[]> {
  const declared = runValidators(
    entity,
    body,
    write.verb === "update" ? { partial: true } : { storeFilled: generatedKeyFields(entity) },
  );
  const refused = [...(declared.ok ? [] : declared.errors.map(toIssue)), ...declaredValueIssues(entity, body)];
  if (refused.length > 0) return refused;
  const issues: WriteIssue[] = [];
  for (const rule of rules) issues.push(...(await rule(write)));
  return issues;
}

interface CollectionParams {
  readonly collection: string;
}
interface MemberParams extends CollectionParams {
  readonly id: string;
}
interface CollectionRoute {
  Params: CollectionParams;
}
interface MemberRoute {
  Params: MemberParams;
}

export function mountDynamicRoutes(options: DynamicRoutesOptions): void {
  const { fastify, prefix, model } = options;
  const rules = options.rules ?? [];
  const collection = `${prefix}/:collection`;
  const member = `${collection}/:id`;

  /** The entity a collection path names in the given model, or undefined for a 404. */
  const entityAt = (current: Model, params: CollectionParams): MetaObject | undefined => current.served.get(params.collection);
  /** The entity and the row a member path names in the given model, or undefined for a 404. */
  function memberAt(current: Model, params: MemberParams): { entity: MetaObject; id: string } | undefined {
    const entity = entityAt(current, params);
    const id = entity === undefined ? undefined : rowKey(entity, params.id);
    return entity === undefined || id === undefined ? undefined : { entity, id };
  }
  const notFound = (reply: FastifyReply): FastifyReply => reply.code(404).send({ error: ERROR_NOT_FOUND });

  fastify.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err.code === "FST_ERR_CTP_INVALID_JSON_BODY" || err.code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
      return reply.code(400).send({ error: ERROR_INVALID_JSON });
    }
    // The detail goes to the server log. The caller is told only that it failed.
    reply.log.error(err);
    return reply.code(500).send({ error: ERROR_INTERNAL });
  });

  // The effective model, as the browser reads it. `mountMetaRoute` from runtime-ts serves
  // the same body, but for a root fixed at mount time; this one follows a reload.
  fastify.get(`${prefix}${META_ROUTE_PATH}`, async (_req, reply) =>
    reply.code(200).header("content-type", META_CONTENT_TYPE).send(metaJson(model().root)),
  );

  fastify.get(`${prefix}${SERVED_ROUTE_PATH}`, async (): Promise<ServedInfo> => {
    const current = model();
    return {
      revision: current.revision,
      collections: Object.fromEntries([...current.served].map(([segment, entity]) => [entity.name, segment])),
      pagination: apiPaginationOf(current.root) ?? null,
    };
  });

  fastify.get<CollectionRoute>(collection, async (req, reply) => {
    const current = model();
    const entity = entityAt(current, req.params);
    if (entity === undefined) return notFound(reply);
    let list;
    try {
      list = readListQuery(entity, isRecord(req.query) ? req.query : {}, apiPaginationOf(current.root));
    } catch (err) {
      if (err instanceof ListQueryError) return reply.code(400).send({ error: err.code, ...err.details });
      throw err;
    }
    // The total ignores the page: it is how many rows the filter matches.
    const [stored, total] = await Promise.all([
      current.om.findMany(entity.name, list.filter, list.opts),
      list.withCount ? current.om.count(entity.name, list.filter) : undefined,
    ]);
    const rows = stored.map(shownBy(entity));
    return total === undefined ? rows : { rows, total };
  });

  fastify.get<MemberRoute>(member, async (req, reply) => {
    const current = model();
    const at = memberAt(current, req.params);
    if (at === undefined) return notFound(reply);
    const row = await current.om.findById(at.entity.name, at.id);
    return row === null ? notFound(reply) : shownBy(at.entity)(row);
  });

  fastify.post<CollectionRoute>(collection, async (req, reply) => {
    const current = model();
    const entity = entityAt(current, req.params);
    if (entity === undefined) return notFound(reply);
    const row = readBody(current, entity, req.body, reply);
    if (row === undefined) return reply;
    return answerWrite(reply, async () => {
      const next = { ...declaredDefaults(entity), ...row };
      const issues = await writeIssues(rules, entity, row, { entity: entity.name, verb: "create", next, om: current.om });
      if (issues.length > 0) return validation(reply, issues);
      return reply.code(201).send(shownBy(entity)(await current.om.create(entity.name, row)));
    });
  });

  const update = async (req: FastifyRequest<MemberRoute>, reply: FastifyReply): Promise<FastifyReply> => {
    const current = model();
    const at = memberAt(current, req.params);
    if (at === undefined) return notFound(reply);
    const { entity, id } = at;
    const row = readBody(current, entity, req.body, reply);
    if (row === undefined) return reply;
    return answerWrite(reply, async () => {
      // A rule judges the row as it will stand, so it needs the stored one under the body.
      const stored = await current.om.findById(entity.name, id);
      if (stored === null) return notFound(reply);
      const next = { ...stored, ...row };
      const issues = await writeIssues(rules, entity, row, { entity: entity.name, verb: "update", next, stored, om: current.om });
      if (issues.length > 0) return validation(reply, issues);
      const updated = await current.om.update(entity.name, id, row, { ifMissing: "ignore" });
      return updated === null ? notFound(reply) : reply.code(200).send(shownBy(entity)(updated));
    });
  };
  // The update verb answers on both methods, as every port's routes do.
  fastify.patch<MemberRoute>(member, update);
  fastify.put<MemberRoute>(member, update);

  fastify.delete<MemberRoute>(member, async (req, reply) => {
    const current = model();
    const at = memberAt(current, req.params);
    if (at === undefined) return notFound(reply);
    return answerWrite(reply, async () =>
      // "ignore": a missing row is this route's 404 to answer, not an exception.
      (await current.om.delete(at.entity.name, at.id, { ifMissing: "ignore" })) ? reply.code(204).send() : notFound(reply),
    );
  });
}
