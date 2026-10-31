// FR-022 — an object as JSON Schema, one schema per wire shape. ACCURATE BY CONSTRUCTION: the create
// and update shapes walk `insertSchemaFields` / `updateSchemaFields`, the field sets the generated
// write validators are built from, so a contract cannot name a field the route does not take.
//
//   read    every field but a credential, each key present (a top-level null is written `null`).
//           A value object's optional members follow `wire.nullMembers` instead.
//   create  what POST takes. A server-set field (generated key, @autoSet, derived, read-only, a
//           write-denied field) is left out, and a TPH subtype's discriminator comes from the URL.
//   update  what PATCH and PUT take: nothing required, and a non-@required field may be null to
//           clear it (FR-035).

import {
  type MetaField,
  type MetaObject,
  type MetaRoot,
  WIRE_NULL_MEMBERS_EMIT,
  WIRE_NULL_MEMBERS_OMIT,
  type WireFormat,
  wireFormatOf,
} from "@metaobjectsdev/metadata";
import { DOC_ATTR_DESCRIPTION, OBJECT_SUBTYPE_VALUE } from "@metaobjectsdev/metadata/constants";
import { hiddenFieldNames, servesWriteApi, tphHierarchy, writeDeniedFieldNames } from "../api-surface.js";
import { isAbstract } from "../instance-artifacts.js";
import { tphPlan } from "../templates/tph-discriminator.js";
import { insertSchemaFields, updateSchemaFields } from "../templates/zod-validators.js";
import { tphDiscriminatorPin } from "../tph.js";
import { type ContractShape, fieldSchema, type JsonSchema, type RefFor, withNull } from "./field-schema.js";

export interface ObjectSchemaEnv {
  readonly root: MetaRoot;
  readonly refFor: RefFor;
  /** Name a TPH base's subtypes with OpenAPI's `discriminator`, which plain JSON Schema does not define. */
  readonly openApiDiscriminator?: boolean;
}

function isValueObject(obj: MetaObject): boolean {
  return obj.subType === OBJECT_SUBTYPE_VALUE;
}

/** Whether the object has the create and update shapes of a served, writable resource. */
function isWritableResource(obj: MetaObject, root: MetaRoot): boolean {
  return servesWriteApi(obj) && tphPlan(obj, root) === null;
}

/** The shapes an object has: a read shape always, the write shapes where something can write it. */
export function shapesOf(obj: MetaObject, root: MetaRoot): readonly ContractShape[] {
  if (isValueObject(obj)) return ["read", "create"];
  return isWritableResource(obj, root) ? ["read", "create", "update"] : ["read"];
}

/** The objects a contract covers. An abstract object has no rows of its own, unless it is a TPH base. */
export function contractObjects(objects: readonly MetaObject[], root: MetaRoot): MetaObject[] {
  return objects.filter((o) => !isAbstract(o) || tphPlan(o, root) !== null);
}

/** `{ type, properties, required }`, with `required` left out when nothing is. */
function objectBody(properties: Record<string, JsonSchema>, required: readonly string[]): JsonSchema {
  return { type: "object", properties, ...(required.length > 0 && { required: [...required] }) };
}

/** A TPH base reads as whichever subtype a row is. */
function polymorphicSchema(obj: MetaObject, env: ObjectSchemaEnv): JsonSchema | undefined {
  const plan = tphPlan(obj, env.root);
  if (plan === null) return undefined;
  const oneOf = plan.subtypes.map((s) => ({ $ref: env.refFor(s.entity, "read") }));
  if (env.openApiDiscriminator !== true) return { oneOf };
  const mapping = Object.fromEntries(plan.subtypes.map((s) => [s.value, env.refFor(s.entity, "read")]));
  return { oneOf, discriminator: { propertyName: plan.discriminatorField, mapping } };
}

function readSchema(obj: MetaObject, env: ObjectSchemaEnv, wire: WireFormat): JsonSchema {
  const polymorphic = polymorphicSchema(obj, env);
  if (polymorphic !== undefined) return polymorphic;
  const pk = new Set<string>(obj.primaryIdentity()?.fields ?? []);
  const pin = tphDiscriminatorPin(obj);
  const hidden = new Set(hiddenFieldNames(obj, tphHierarchy(obj, env.root)));
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  // A credential is never on the wire: the key is absent, not null.
  for (const field of obj.fields().filter((f) => !hidden.has(f.name))) {
    if (pin !== undefined && field.name === pin.fieldName) {
      properties[field.name] = { const: pin.value };
      required.push(field.name);
      continue;
    }
    const schema = fieldSchema(field, "read", env.refFor, wire);
    if (pk.has(field.name) || field.isRequired) {
      properties[field.name] = schema;
      required.push(field.name);
    } else if (isValueObject(obj) && wire.nullMembers === WIRE_NULL_MEMBERS_OMIT) {
      properties[field.name] = schema;
    } else if (isValueObject(obj) && wire.nullMembers !== WIRE_NULL_MEMBERS_EMIT) {
      properties[field.name] = withNull(schema);
    } else {
      properties[field.name] = withNull(schema);
      required.push(field.name);
    }
  }
  return objectBody(properties, required);
}

/** The fields no client writes, as the routes decide it: across a TPH hierarchy's one table. */
function writeDenied(obj: MetaObject, env: ObjectSchemaEnv): ReadonlySet<string> {
  return new Set(writeDeniedFieldNames(obj, tphHierarchy(obj, env.root)));
}

/** Whether a client writes this field: not a server-filled one, and not a write-denied one. */
function isClientWritten(field: MetaField | undefined, serverSet: boolean | undefined, denied: ReadonlySet<string>): field is MetaField {
  return field !== undefined && serverSet !== true && !denied.has(field.name);
}

function createSchema(obj: MetaObject, env: ObjectSchemaEnv, wire: WireFormat): JsonSchema {
  const fieldByName = new Map(obj.fields().map((f) => [f.name, f]));
  const denied = writeDenied(obj, env);
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const shape of insertSchemaFields(obj)) {
    const field = fieldByName.get(shape.name);
    // A TPH subtype's discriminator is injected from the URL, not read from the body.
    if (shape.pinnedLiteral !== undefined || !isClientWritten(field, shape.autoSet, denied)) continue;
    properties[shape.name] = fieldSchema(field, "create", env.refFor, wire);
    if (!shape.optional) required.push(shape.name);
  }
  return objectBody(properties, required);
}

function updateSchema(obj: MetaObject, env: ObjectSchemaEnv, wire: WireFormat): JsonSchema {
  const fieldByName = new Map(obj.fields().map((f) => [f.name, f]));
  const pk = new Set<string>(obj.primaryIdentity()?.fields ?? []);
  const denied = writeDenied(obj, env);
  const properties: Record<string, JsonSchema> = {};
  for (const shape of updateSchemaFields(obj)) {
    const field = fieldByName.get(shape.name);
    if (!isClientWritten(field, shape.autoSet, denied)) continue;
    const schema = fieldSchema(field, "update", env.refFor, wire);
    // FR-035: a present null clears a non-@required field. A key is never cleared.
    properties[shape.name] = field.isRequired || pk.has(shape.name) ? schema : withNull(schema);
  }
  return objectBody(properties, []);
}

/** The object's schema in one shape, without a document's `$schema` or `$id`. */
export function objectSchema(obj: MetaObject, shape: ContractShape, env: ObjectSchemaEnv): JsonSchema {
  const wire = wireFormatOf(env.root);
  const body = shape === "read" ? readSchema(obj, env, wire) : shape === "create" ? createSchema(obj, env, wire) : updateSchema(obj, env, wire);
  const description = obj.attr(DOC_ATTR_DESCRIPTION);
  return { ...(typeof description === "string" && { description }), ...body };
}

/** One object in one wire shape. */
export interface ContractTarget {
  readonly obj: MetaObject;
  readonly shape: ContractShape;
}

export interface ContractEntry extends ContractTarget {
  readonly schema: JsonSchema;
}

/** How one object's schema points at another: from a file to a file, or at a component. */
export type RefFrom = (from: MetaObject, target: MetaObject, shape: ContractShape) => string;

/**
 * Every schema a set of objects needs: their own shapes, and each shape a `$ref` reaches, so a
 * reference never dangles when the generator's `filter` leaves its target out of the set.
 */
export function collectContractEntries(
  objects: readonly MetaObject[],
  root: MetaRoot,
  refFrom: RefFrom,
  options: {
    readonly openApiDiscriminator?: boolean;
    /** Shapes something outside these schemas points at, such as an OpenAPI path. */
    readonly referenced?: readonly ContractTarget[];
  } = {},
): ContractEntry[] {
  const queued = new Map<string, ContractTarget>();
  const queue = (obj: MetaObject, shape: ContractShape): void => {
    const key = `${obj.resolutionKey()}#${shape}`;
    if (!queued.has(key)) queued.set(key, { obj, shape });
  };
  for (const obj of objects) for (const shape of shapesOf(obj, root)) queue(obj, shape);
  for (const { obj, shape } of options.referenced ?? []) queue(obj, shape);

  const entries: ContractEntry[] = [];
  // A Map iterates what is added while it is walked, so this visits everything `refFor` queues.
  for (const { obj, shape } of queued.values()) {
    const refFor: RefFor = (target, targetShape) => {
      queue(target, targetShape);
      return refFrom(obj, target, targetShape);
    };
    const { openApiDiscriminator } = options;
    entries.push({ obj, shape, schema: objectSchema(obj, shape, { root, refFor, ...(openApiDiscriminator !== undefined && { openApiDiscriminator }) }) });
  }
  return entries;
}
