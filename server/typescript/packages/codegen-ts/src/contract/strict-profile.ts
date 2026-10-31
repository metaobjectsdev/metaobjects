// FR-022 — the strict profile: one schema every structured-output host accepts. It is the
// intersection of what they take, not a variant per host: the root is an object, every property is
// required and optional ones are `["T", "null"]`, every object closes with
// `additionalProperties: false`, and there is no `$ref`, no recursion and no constraint keyword.
// What a keyword said moves into `description`, where a model still reads it.
//
// The shape is the one a model would fill in: the object's create shape where it has one, else its
// read shape. A strict document has no `$schema` or `$id`, because it is pasted into a request.

import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import { type ContractShape, type JsonSchema, withNull } from "./field-schema.js";
import { ContractEmitError, ERR_CONTRACT_STRICT_UNREPRESENTABLE } from "./contract-errors.js";
import { objectSchema, shapesOf } from "./object-schema.js";
import { tphPlan } from "../templates/tph-discriminator.js";

/** What each dropped keyword becomes in `description`. */
const KEYWORD_PROSE: readonly (readonly [string, string])[] = [
  ["format", "Format"],
  ["pattern", "Pattern"],
  ["minLength", "Minimum length"],
  ["maxLength", "Maximum length"],
  ["minimum", "Minimum"],
  ["maximum", "Maximum"],
  ["minItems", "Minimum items"],
  ["maxItems", "Maximum items"],
];

/** Pointers handed out while building, back to the object and shape each one names. */
type Pointers = Map<string, { target: MetaObject; shape: ContractShape }>;

interface Walk {
  readonly root: MetaRoot;
  readonly owner: MetaObject;
  readonly pointers: Pointers;
  /** The objects being inlined, outermost first: meeting one again is a cycle. */
  readonly stack: readonly MetaObject[];
  /** The property path from the owner, for the refusal to name. */
  readonly at: readonly string[];
}

function unrepresentable(walk: Walk, why: string): ContractEmitError {
  const at = walk.at.length === 0 ? "" : ` (at '${walk.at.join(".")}')`;
  return new ContractEmitError(
    ERR_CONTRACT_STRICT_UNREPRESENTABLE,
    `'${walk.owner.resolutionKey()}' has no strict schema: ${why}${at}. Leave it out with the generator's filter option.`,
  );
}

/** `description`, with what the dropped keywords said appended to it. */
function proseOf(schema: JsonSchema, extra: readonly string[] = []): JsonSchema {
  const parts = typeof schema.description === "string" ? [schema.description] : [];
  for (const [keyword, label] of KEYWORD_PROSE) {
    // `int64` and its kin size a number for a code generator. They say nothing to a model.
    if (keyword === "format" && soleType(schema) !== "string") continue;
    if (schema[keyword] !== undefined) parts.push(`${label}: ${String(schema[keyword])}.`);
  }
  parts.push(...extra);
  return parts.length === 0 ? {} : { description: parts.join(" ") };
}

/** The first type that is not null: a strict scalar has one type, plus null when optional. */
function soleType(schema: JsonSchema): unknown {
  return Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
}

function isNullable(schema: JsonSchema): boolean {
  return Array.isArray(schema.type) && schema.type.includes("null");
}

function strictOfObject(schema: JsonSchema, walk: Walk): JsonSchema {
  if (schema.additionalProperties !== undefined) throw unrepresentable(walk, "a map has keys no schema can list");
  if (schema.properties === undefined) throw unrepresentable(walk, "an open object has properties no schema can list");
  const declared = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const properties: Record<string, JsonSchema> = {};
  for (const [name, value] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
    const strict = strictOf(value, { ...walk, at: [...walk.at, name] });
    properties[name] = declared.has(name) ? strict : withNull(strict);
  }
  return {
    ...(schema.title !== undefined && { title: schema.title }),
    ...proseOf(schema),
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function strictOfScalar(schema: JsonSchema): JsonSchema {
  const nullable = isNullable(schema);
  const type = soleType(schema);
  // `inet`'s anyOf is two formats on one string.
  const formats = Array.isArray(schema.anyOf) ? schema.anyOf.map((f) => (f as JsonSchema).format) : [];
  const prose = proseOf(schema, formats.length > 0 ? [`Format: ${formats.join(" or ")}.`] : []);
  return {
    ...prose,
    type: nullable ? [type, "null"] : type,
    ...(schema.enum !== undefined && { enum: schema.enum }),
  };
}

function inlineRef(ref: string, walk: Walk): JsonSchema {
  const pointer = walk.pointers.get(ref);
  if (pointer === undefined) throw new Error(`strict profile: no object behind '${ref}'.`);
  const { target, shape } = pointer;
  if (walk.stack.includes(target)) {
    const cycle = [...walk.stack, target].map((o) => o.name).join(" -> ");
    throw unrepresentable(walk, `its shape is recursive (${cycle})`);
  }
  return strictOf(buildRaw(target, shape, walk.root, walk.pointers), { ...walk, stack: [...walk.stack, target] });
}

/** One schema, as the strict subset states it. */
function strictOf(schema: JsonSchema, walk: Walk): JsonSchema {
  if (typeof schema.$ref === "string") return inlineRef(schema.$ref, walk);
  if (Array.isArray(schema.oneOf)) throw unrepresentable(walk, "a polymorphic object has no single shape");
  // `withNull` over a `$ref`: the target, nullable.
  const anyOf = schema.anyOf as JsonSchema[] | undefined;
  if (anyOf !== undefined && typeof anyOf[0]?.$ref === "string") {
    const inlined = withNull(inlineRef(anyOf[0].$ref, walk));
    return schema.description === undefined ? inlined : { ...inlined, description: schema.description };
  }
  const type = soleType(schema);
  if (type === "object") {
    const strict = strictOfObject(schema, walk);
    return isNullable(schema) ? withNull(strict) : strict;
  }
  if (type === "array") {
    return {
      ...proseOf(schema),
      type: isNullable(schema) ? ["array", "null"] : "array",
      items: strictOf(schema.items as JsonSchema, walk),
    };
  }
  if (type === undefined) throw unrepresentable(walk, "an open value has no type to state");
  return strictOfScalar(schema);
}

function buildRaw(obj: MetaObject, shape: ContractShape, root: MetaRoot, pointers: Pointers): JsonSchema {
  return objectSchema(obj, shape, {
    root,
    refFor: (target, targetShape) => {
      const pointer = `strict:${target.resolutionKey()}#${targetShape}`;
      pointers.set(pointer, { target, shape: targetShape });
      return pointer;
    },
  });
}

/** Whether the object has a strict schema: a TPH base is a union, and each subtype has its own. */
export function hasStrictSchema(obj: MetaObject, root: MetaRoot): boolean {
  return tphPlan(obj, root) === null;
}

/** The object's strict schema. Throws when the strict subset cannot state it. */
export function strictSchema(obj: MetaObject, root: MetaRoot): JsonSchema {
  const shape: ContractShape = shapesOf(obj, root).includes("create") ? "create" : "read";
  const pointers: Pointers = new Map();
  const raw = buildRaw(obj, shape, root, pointers);
  return strictOf({ title: obj.name, ...raw }, { root, owner: obj, pointers, stack: [obj], at: [] });
}
